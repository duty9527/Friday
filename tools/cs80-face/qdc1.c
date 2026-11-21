/* CS80 状态屏 sidecar：独占 USB，吃主机来的二进制消息，推帧/局部更新/控屏。
 *
 * 为什么要单独一个进程：USB 设备被独占（macOS IOKit、Windows COM 口），
 * 编辑器和常驻 runtime 只能通过它间接操作设备。
 *
 * 编译（macOS）：clang -O2 -o qdc1 qdc1.c lz4.c -framework IOKit -framework CoreFoundation
 * 编译（Windows）：见 panel/build-win.md（同一份文件，_WIN32 分支走 COM 口）
 *
 * stdin 二进制协议（小端）：
 *   0x01                        + 800*1280*3 B RGB888   → 整帧
 *   0x02 + u32 n + n*(u16 x,u16 y, 32*16*2 B BGR565)    → 局部 tile 更新
 *   0x03 + u8 cmd + u8 arg                              → 控屏
 *   0x04 + 800*1280*2 B BGR565                          → 屏保：跳过 RGB 转换直接整帧
 *        cmd: 1=设亮度(arg=5..100,步长5) 2=待机 3=唤醒 4=查询状态 5=握手
 *   0x05 + u8 sub + u8[3] + u32 len + u32 offset + u32 raw + payload → 音频控制（QDC1 type 7）
 *        sub: 0=查询 1=停止 2=音量(offset) 3=开始上传(offset=总字节,raw=XXH32)
 *             4=结束上传 5=播放 6=读回校验 7=开始 PCM 8=诊断 9=路由
 *   0x06 + u32 offset + u32 len + payload               → MP3 上传块（type 8，len≤16384）
 *   0x07 + u32 len + payload                            → 实时 PCM（type 9，len≤16384）
 * stdout：每条命令一行 JSON（供上层做状态面板）
 * stderr：人类可读日志
 *
 * 命令行：--com COMx（Windows 指定口）/ --probe（扫所有 COM 找 QDC1）
 *         / --hello COMx（只验一个口，host 用来排除过期的注册表映射）
 */
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#include <windows.h>
#define read _read
static int wait_stdin(int ms) { return WaitForSingleObject(GetStdHandle(STD_INPUT_HANDLE), (DWORD)ms) == WAIT_OBJECT_0; }
static double wall_ms(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER c;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)freq.QuadPart;
}
#else
#include <errno.h>
#include <poll.h>
#include <sys/time.h>
#include <unistd.h>
#ifdef __linux__
#include <dirent.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <linux/usbdevice_fs.h>
#endif
static int wait_stdin(int ms) { struct pollfd p = {0, POLLIN, 0}; return poll(&p, 1, ms) > 0; }
static double wall_ms(void) {
#ifdef CLOCK_MONOTONIC
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0) {
    return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6;
  }
#endif
  struct timeval t;
  gettimeofday(&t, 0);
  return t.tv_sec * 1e3 + t.tv_usec / 1e3;
}
#endif

#if !defined(_WIN32) && !defined(__linux__)
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#endif

#define LZ4_STATIC_LINKING_ONLY
#include "lz4.h"

#define WIDTH 800u
#define HEIGHT 1280u
#define FRAME_BYTES (WIDTH * HEIGHT * 2u)
#define FRAME_RGB (WIDTH * HEIGHT * 3u)
#define BLOCK_BYTES 512000u
#define TX_BUF_BYTES (32u + (size_t)LZ4_COMPRESSBOUND(BLOCK_BYTES))
#define TILE_W 32u
#define TILE_H 16u
#define TILE_BYTES (TILE_W * TILE_H * 2u)
#define TILE_MSG (4u + TILE_BYTES) /* 主机来的 tile：u16 x,u16 y + 像素 */
#define MAX_TILES ((BLOCK_BYTES - 8u) / (TILE_BYTES + 8u))
#define MAGIC 0x31434451u
#define ACK_TRIES 5 /* 5 × 400ms 收不到任何 ACK → 判定 USB 链路已死 */
/* 音频分块上限与固件一致：type 8/9 单块 1..16384 字节 */
#define AUDIO_CHUNK 16384u
enum {
  QD_HELLO = 1,
  QD_BEGIN = 2,
  QD_DATA = 3,
  QD_COMMIT = 4,
  QD_VERIFY = 6,
  QD_AUDIO = 7,
  QD_AUDIO_DATA = 8,
  QD_PCM = 9,
  QD_PATCH = 10,
  QD_ACK = 128
};
enum { CTL_BRIGHTNESS = 1, CTL_SLEEP = 2, CTL_WAKE = 3, CTL_STATE = 4, CTL_HELLO = 5 };

static volatile sig_atomic_t stop;
static int debug;
static const char *arg_com; /* --com COMx（仅 Windows 用） */
typedef struct link_s link_t_fwd;
static link_t_fwd *g_link;
static void json(const char *fmt, ...);

static void on_signal(int sig) { (void)sig; stop = 1; }

/* 带时间戳的 stderr 日志：排查「隔一阵断一次」时要和 host/内核日志对时间 */
static void tlog(const char *fmt, ...) {
  time_t t = time(NULL);
  struct tm *tm = localtime(&t);
  if (tm) fprintf(stderr, "%02d:%02d:%02d ", tm->tm_hour, tm->tm_min, tm->tm_sec);
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

/* ---------- XXH32（与固件 Hash32 一致，seed 0）---------- */
static uint32_t rd32(const void *p) {
  const uint8_t *b = p;
  return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}
static void wr32(uint8_t *b, uint32_t v) { b[0] = v; b[1] = v >> 8; b[2] = v >> 16; b[3] = v >> 24; }
#define ROTL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))
static uint32_t xxh32(const void *data, size_t len) {
  const uint8_t *p = data, *end = p + len;
  const uint32_t P1 = 2654435761u, P2 = 2246822519u, P3 = 3266489917u, P4 = 668265263u, P5 = 374761393u;
  uint32_t h;
  if (len >= 16) {
    uint32_t v1 = P1 + P2, v2 = P2, v3 = 0, v4 = 0u - P1;
    for (; p + 16 <= end; p += 16) {
      v1 = ROTL(v1 + rd32(p) * P2, 13) * P1;
      v2 = ROTL(v2 + rd32(p + 4) * P2, 13) * P1;
      v3 = ROTL(v3 + rd32(p + 8) * P2, 13) * P1;
      v4 = ROTL(v4 + rd32(p + 12) * P2, 13) * P1;
    }
    h = ROTL(v1, 1) + ROTL(v2, 7) + ROTL(v3, 12) + ROTL(v4, 18);
  } else {
    h = P5;
  }
  h += (uint32_t)len;
  for (; p + 4 <= end; p += 4) h = ROTL(h + rd32(p) * P3, 17) * P4;
  for (; p < end; p++) h = ROTL(h + *p * P5, 11) * P1;
  h ^= h >> 15;
  h *= P2;
  h ^= h >> 13;
  h *= P3;
  return h ^ (h >> 16);
}

/* ---------- 传输层 ---------- */
struct link_s;
typedef struct link_s {
#ifdef _WIN32
  HANDLE port;
#elif defined(__linux__)
  int fd;
  int iface;
  uint8_t ep_out, ep_in;
#else
  IOUSBInterfaceInterface **intf;
  uint8_t pipe_out, pipe_in;
#endif
  uint8_t *tx;
  size_t tx_cap;
  uint32_t seq;
} link_t;

#if defined(__linux__) /* ---------- Linux：usbfs（接口 32 超出 libusb 0..31 位图） ---------- */
static int read_sys(const char *path, char *buf, size_t n) {
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  if (!fgets(buf, (int)n, f)) { fclose(f); return -1; }
  fclose(f);
  buf[strcspn(buf, "\n")] = 0;
  return 0;
}

static int find_device(char *out, size_t n) {
  DIR *d = opendir("/sys/bus/usb/devices");
  if (!d) return -1;
  struct dirent *e;
  int found = -1;
  while ((e = readdir(d))) {
    if (e->d_name[0] == '.') continue;
    char p[512], v[16], pid[16], bus[16], dev[16];
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/idVendor", e->d_name);
    if (read_sys(p, v, sizeof v) || strcmp(v, "2c7c")) continue;
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/idProduct", e->d_name);
    if (read_sys(p, pid, sizeof pid) || strcmp(pid, "0901")) continue;
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/busnum", e->d_name);
    if (read_sys(p, bus, sizeof bus)) continue;
    snprintf(p, sizeof p, "/sys/bus/usb/devices/%s/devnum", e->d_name);
    if (read_sys(p, dev, sizeof dev)) continue;
    snprintf(out, n, "/dev/bus/usb/%03d/%03d", atoi(bus), atoi(dev));
    found = 0;
    break;
  }
  closedir(d);
  return found;
}

static int open_link(link_t *l, int iface_number) {
  char path[128];
  l->fd = -1;
  if (find_device(path, sizeof path)) {
    tlog("cs80: 找不到 2c7c:0901 设备\n");
    return -1;
  }
  int fd = open(path, O_RDWR | O_CLOEXEC);
  if (fd < 0) {
    fprintf(stderr, "cs80: 打开 %s 失败：%s（root 或 udev 权限）\n", path, strerror(errno));
    return -3;
  }
  /* 一步完成「踢掉 option 驱动 + claim 接口」，比先 unbind 稳。 */
  struct usbdevfs_disconnect_claim dc;
  memset(&dc, 0, sizeof dc);
  dc.interface = (unsigned)iface_number;
  dc.flags = USBDEVFS_DISCONNECT_CLAIM_EXCEPT_DRIVER;
  if (ioctl(fd, USBDEVFS_DISCONNECT_CLAIM, &dc) < 0) {
    unsigned i = (unsigned)iface_number;
    if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &i) < 0) {
      fprintf(stderr, "cs80: claim 接口 %d 失败：%s\n", iface_number, strerror(errno));
      close(fd);
      return -3;
    }
  }
  l->fd = fd;
  l->iface = iface_number;
  l->ep_out = getenv("CS80_EP_OUT") ? (uint8_t)strtoul(getenv("CS80_EP_OUT"), NULL, 0) : 0x08;
  l->ep_in = getenv("CS80_EP_IN") ? (uint8_t)strtoul(getenv("CS80_EP_IN"), NULL, 0) : 0x8b;
  l->tx_cap = TX_BUF_BYTES;
  l->tx = malloc(l->tx_cap);
  if (!l->tx) {
    unsigned i = (unsigned)iface_number;
    ioctl(fd, USBDEVFS_RELEASEINTERFACE, &i);
    close(fd);
    l->fd = -1;
    l->tx_cap = 0;
    return -4;
  }
  tlog("cs80: %s if%d ep_out=0x%02x ep_in=0x%02x\n", path, iface_number, l->ep_out, l->ep_in);
  /* 清掉上一轮进程遗留的迟到 ACK，避免新会话第一个命令读到旧 seq。 */
  for (int i = 0; i < 32; i++) {
    uint8_t junk[256];
    struct usbdevfs_bulktransfer t = { .ep = l->ep_in, .len = sizeof junk, .timeout = 20, .data = junk };
    if (ioctl(fd, USBDEVFS_BULK, &t) < 0) break;
  }
  return 0;
}

static void close_link(link_t *l) {
  if (l->fd >= 0) {
    unsigned i = (unsigned)l->iface;
    ioctl(l->fd, USBDEVFS_RELEASEINTERFACE, &i);
    close(l->fd);
    l->fd = -1;
  }
  free(l->tx);
  l->tx = NULL;
  l->tx_cap = 0;
}

static int raw_write(link_t *l, const void *buf, uint32_t len) {
  struct usbdevfs_bulktransfer t = { .ep = l->ep_out, .len = len, .timeout = 5000, .data = (void *)buf };
  int r = ioctl(l->fd, USBDEVFS_BULK, &t);
  if (r < 0) return -errno;
  return r == (int)len ? 0 : -EIO;
}

static int raw_read(link_t *l, void *buf, uint32_t *len, int timeout_ms) {
  struct usbdevfs_bulktransfer t = { .ep = l->ep_in, .len = *len, .timeout = timeout_ms, .data = buf };
  int r = ioctl(l->fd, USBDEVFS_BULK, &t);
  if (r < 0) { *len = 0; return -errno; }
  *len = (uint32_t)r;
  return 0;
}

#elif !defined(_WIN32) /* ---------- macOS：IOKit ---------- */
static int get_num(io_service_t s, CFStringRef key, int *out) {
  CFTypeRef v = IORegistryEntryCreateCFProperty(s, key, kCFAllocatorDefault, 0);
  int ok = 0;
  if (v && CFGetTypeID(v) == CFNumberGetTypeID()) ok = CFNumberGetValue(v, kCFNumberIntType, out) ? 1 : 0;
  if (v) CFRelease(v);
  return ok;
}

/* QDC1 数据口 = USB 接口 32（Windows 的 MI_20）。libusb 打不开它，IOKit 可以。 */
static int open_link(link_t *l, int iface_number) {
  io_iterator_t it;
  io_service_t s, dev_service = 0;
  int found = 0;
  if (IOServiceGetMatchingServices(kIOMasterPortDefault, IOServiceMatching("IOUSBHostDevice"), &it)) return -1;
  while ((s = IOIteratorNext(it))) {
    int v = 0, p = 0;
    if (!found && get_num(s, CFSTR("idVendor"), &v) && get_num(s, CFSTR("idProduct"), &p) && v == 0x2C7C && p == 0x0901) {
      dev_service = s;
      found = 1;
    } else {
      IOObjectRelease(s);
    }
  }
  IOObjectRelease(it);
  if (!dev_service) return -1;

  IOCFPlugInInterface **plug = NULL;
  SInt32 score = 0;
  IOUSBDeviceInterface **dev = NULL;
  int rc = -2;
  if (IOCreatePlugInInterfaceForService(dev_service, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score)) {
    IOObjectRelease(dev_service);
    return -2;
  }
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&dev);
  (*plug)->Release(plug);
  if (!dev) {
    IOObjectRelease(dev_service);
    return -2;
  }
  if ((*dev)->USBDeviceOpen(dev) != kIOReturnSuccess) {
    (*dev)->Release(dev);
    IOObjectRelease(dev_service);
    return -3;
  }
  (*dev)->SetConfiguration(dev, 1);

  IOUSBFindInterfaceRequest req = {kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare,
                                   kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare};
  io_iterator_t iit;
  io_service_t isvc;
  (*dev)->CreateInterfaceIterator(dev, &req, &iit);
  while ((isvc = IOIteratorNext(iit))) {
    int num = -1;
    get_num(isvc, CFSTR("bInterfaceNumber"), &num);
    if (num != iface_number) {
      IOObjectRelease(isvc);
      continue;
    }
    IOCFPlugInInterface **iplug = NULL;
    IOUSBInterfaceInterface **intf = NULL;
    if (!IOCreatePlugInInterfaceForService(isvc, kIOUSBInterfaceUserClientTypeID, kIOCFPlugInInterfaceID, &iplug, &score)) {
      (*iplug)->QueryInterface(iplug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID), (LPVOID *)&intf);
      (*iplug)->Release(iplug);
    }
    IOObjectRelease(isvc);
    if (!intf) break;
    if ((*intf)->USBInterfaceOpen(intf) != kIOReturnSuccess) {
      (*intf)->Release(intf);
      break;
    }
    UInt8 n = 0;
    (*intf)->GetNumEndpoints(intf, &n);
    l->intf = intf;
    l->pipe_out = l->pipe_in = 0;
    for (UInt8 i = 1; i <= n; i++) {
      UInt8 dir, num2, type, interval;
      UInt16 mps;
      (*intf)->GetPipeProperties(intf, i, &dir, &num2, &type, &mps, &interval);
      if (type != kUSBBulk) continue;
      if (dir == kUSBIn)
        l->pipe_in = i;
      else
        l->pipe_out = i;
    }
    if (!l->pipe_out || !l->pipe_in) {
      (*intf)->USBInterfaceClose(intf);
      (*intf)->Release(intf);
      l->intf = NULL;
      break;
    }
    rc = 0;
    break;
  }
  IOObjectRelease(iit);
  (*dev)->USBDeviceClose(dev);
  (*dev)->Release(dev);
  IOObjectRelease(dev_service);
  if (rc) return rc;
  l->tx_cap = TX_BUF_BYTES;
  l->tx = malloc(l->tx_cap);
  if (!l->tx) {
    l->tx_cap = 0;
    close_link(l);
    return -4;
  }
  return 0;
}

static void close_link(link_t *l) {
  if (l->intf) {
    (*l->intf)->USBInterfaceClose(l->intf);
    (*l->intf)->Release(l->intf);
    l->intf = NULL;
  }
  free(l->tx);
  l->tx = NULL;
  l->tx_cap = 0;
}

static int raw_write(link_t *l, const void *buf, uint32_t len) {
  IOReturn r = (*l->intf)->WritePipeTO(l->intf, l->pipe_out, (void *)buf, len, 2000, 5000);
  return r == kIOReturnSuccess ? 0 : (int)r;
}

static int raw_read(link_t *l, void *buf, uint32_t *len, int timeout_ms) {
  IOReturn r = (*l->intf)->ReadPipeTO(l->intf, l->pipe_in, buf, len, timeout_ms, timeout_ms + 500);
  return r == kIOReturnSuccess ? 0 : (int)r;
}
#else /* ---------- Windows：厂商虚拟串口 ---------- */
#include <fcntl.h>
#include <io.h>

static int open_link(link_t *l, int iface_number) {
  (void)iface_number;
  const char *com = (arg_com && arg_com[0]) ? arg_com : getenv("CS80_COM");
  char path[64];
  l->port = INVALID_HANDLE_VALUE;
  if (com && com[0]) {
    snprintf(path, sizeof path, "\\\\.\\%s", com);
    l->port = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (l->port == INVALID_HANDLE_VALUE) return -1;
  } else {
    for (int i = 3; i < 64; i++) { /* 找第一个能打开的 COM 口 */
      snprintf(path, sizeof path, "\\\\.\\COM%d", i);
      HANDLE h = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
      if (h != INVALID_HANDLE_VALUE) {
        l->port = h;
        break;
      }
    }
    if (l->port == INVALID_HANDLE_VALUE) return -1;
  }
  DCB dcb;
  memset(&dcb, 0, sizeof dcb);
  dcb.DCBlength = sizeof dcb;
  GetCommState(l->port, &dcb);
  dcb.BaudRate = 115200;
  dcb.ByteSize = 8;
  dcb.Parity = NOPARITY;
  dcb.StopBits = ONESTOPBIT;
  dcb.fDtrControl = DTR_CONTROL_DISABLE;
  dcb.fRtsControl = RTS_CONTROL_DISABLE;
  SetCommState(l->port, &dcb);
  COMMTIMEOUTS to = {50, 0, 2000, 2, 2000};
  SetCommTimeouts(l->port, &to);
  PurgeComm(l->port, PURGE_RXCLEAR | PURGE_TXCLEAR);
  l->tx_cap = TX_BUF_BYTES;
  l->tx = malloc(l->tx_cap);
  if (!l->tx) {
    l->tx_cap = 0;
    CloseHandle(l->port);
    l->port = NULL;
    return -4;
  }
  return 0;
}

static void close_link(link_t *l) {
  if (l->port && l->port != INVALID_HANDLE_VALUE) CloseHandle(l->port);
  l->port = NULL;
  free(l->tx);
  l->tx = NULL;
  l->tx_cap = 0;
}

static int raw_write(link_t *l, const void *buf, uint32_t len) {
  DWORD done = 0;
  return WriteFile(l->port, buf, len, &done, NULL) && done == len ? 0 : -1;
}

static int raw_read(link_t *l, void *buf, uint32_t *len, int timeout_ms) {
  DWORD got = 0;
  /* 基本功：Windows 的 CDC 读默认按 DCB 超时（2 s），会把 wait_ack 的 400ms 变成
   * 2 s × tries；这里每次按调用方的 timeout 设一次，保证 ACK/保活能按预期快失败。 */
  COMMTIMEOUTS to;
  memset(&to, 0, sizeof to);
  /* ReadIntervalTimeout 非 0 才是关键：数据流出现 10ms 间歇就立刻返回（ACK 是整包来的），
   * 总超时仍按调用方的 timeout 兜底。如果设成 0，ReadFile 会一直等到读满 128 字节或总超时，
   * 每条 ACK 都要白等 400ms。 */
  to.ReadIntervalTimeout = 10;
  to.ReadTotalTimeoutMultiplier = 0;
  to.ReadTotalTimeoutConstant = (DWORD)(timeout_ms > 0 ? timeout_ms : 1);
  SetCommTimeouts(l->port, &to);
  if (!ReadFile(l->port, buf, *len, &got, NULL)) return -1;
  *len = got;
  return got ? 0 : -1;
}
#endif

static double now_ms(void) { return wall_ms(); }

static uint32_t elapsed_ms(double t0) {
  double d = now_ms() - t0;
  return d > 0.0 ? (uint32_t)d : 0u;
}

static void sleep_ms(int ms) {
#ifdef _WIN32
  Sleep((DWORD)ms);
#else
  usleep((useconds_t)ms * 1000);
#endif
}

/* 高速度端点 wMaxPacketSize=512。一次 URB 的长度如果正好是 512 的整数倍，
 * HCD 会用零长度包(ZLP)标记传输结束；这台固件的 QDC1/CDC 接收路径对 ZLP
 * 处理有 bug：它会把整条命令当成没收完，3 s 后回 status=8，屏上就闪一下
 * 「等待连接」。实测 16 tile 的 patch 压出 3552 B + 32 B 头 = 3584 = 7×512
 * 时必现。QDC1 本身是字节流，把最后一字节拆成单独一次写即可绕开。
 * 整帧裸块的 32+512000 不是 512 整数倍，不受影响。 */
static int raw_write_all(link_t *l, const void *buf, uint32_t len) {
  if (len > 1 && (len % 512) == 0) {
    tlog("cs80: split write %u B (512-multiple, avoid ZLP)\n", len);
    int r = raw_write(l, buf, len - 1);
    if (r) return r;
    return raw_write(l, (const uint8_t *)buf + len - 1, 1);
  }
  return raw_write(l, buf, len);
}

static int send_cmd(link_t *l, uint8_t kind, uint16_t flags, uint32_t offset, uint32_t raw, const void *payload,
                    uint32_t len) {
  if (!l->tx || l->tx_cap < 32u || (size_t)len > l->tx_cap - 32u) return -1;
  uint8_t *h = l->tx;
  l->seq++;
  memset(h, 0, 32);
  wr32(h, MAGIC);
  h[4] = 1;
  h[5] = kind;
  h[6] = flags & 0xff;
  h[7] = flags >> 8;
  wr32(h + 8, l->seq);
  wr32(h + 12, offset);
  wr32(h + 16, len);
  wr32(h + 20, raw);
  wr32(h + 24, xxh32(payload ? payload : "", len));
  wr32(h + 28, xxh32(h, 28));
  if (len) memcpy(h + 32, payload, len);
  return raw_write_all(l, h, 32 + len);
}

static uint32_t reply_body[6];
static uint32_t patch_n;

static void link_lost(const char *reason) {
  /* 带上固件回的状态码：0=OK（说明只是我们没等到）1..8 见 docs/protocol.md，
   * 其中 8 = 设备接收超时（数据没在 3 s 内收全，常见于内容太大被丢弃）。 */
  tlog("cs80: 链路丢失 (%s, status=%u)\n", reason, reply_body[0]);
  json("{\"event\":\"lost\",\"reason\":\"%s\"}", reason);
  if (g_link) close_link(g_link);
  exit(3);
}

static int wait_ack(link_t *l, uint32_t seq, int tries) {
  /* 按字节流累积再切包：串口读到的不一定恰好是一条 56 字节的 ACK（可能被拆成
   * 32+24）。以前“读到不够 56 就丢掉”会把拆开的 ACK 丢光 → 整帧 DATA 永远等不到
   * ACK（表现为 no-ack-data，设备停在等待页）。现在累积到缓冲区里逐字节找完整帧。 */
  static uint8_t acc[1024];
  static size_t have;
  /* 不要把 have 清零：上一次可能在 800 ms 内只读到半条 ACK（USB 会把 56 B 拆成
   * 32+24 两次短包），丢掉它就得再等一整个超时。中间的不匹配字节会在下面被滑动跳过。 */
  memset(reply_body, 0, sizeof reply_body);
  uint8_t buf[256];
  for (int i = 0; i < tries && !stop; i++) {
    uint32_t len = sizeof buf;
    if (raw_read(l, buf, &len, 800) == 0 && len) {
      if (debug) fprintf(stderr, "ack read: %u bytes\n", len);
      if (have + len > sizeof acc) have = 0;  /* 异常数据，重来 */
      memcpy(acc + have, buf, len);
      have += len;
    }
    size_t off = 0;
    while (have - off >= 56) {
      uint8_t *p = acc + off;
      if (rd32(p) == MAGIC && p[5] == QD_ACK && rd32(p + 28) == xxh32(p, 28)) {
        if (debug) fprintf(stderr, "ack frame: seq=%u expect=%u status=%u\n", rd32(p + 8), seq, rd32(p + 32));
        if (rd32(p + 8) == seq) {
          for (int k = 0; k < 6; k++) reply_body[k] = rd32(p + 32 + 4 * k);
          have = 0;
          return 0;
        }
        off += 56;
        continue;
      }
      off += 1; /* 不对齐/不是 ACK：滑动一字节重新对齐 */
    }
    if (off) {
      have -= off;
      memmove(acc, acc + off, have);
    }
  }
  if (have > 55) {  /* 只留可能是半条 ACK 的尾巴，其余是垃圾 */
    memmove(acc, acc + have - 55, 55);
    have = 55;
  }
  return -1;
}
/* ---------- 帧状态：本地影子 framebuffer，用于算 patch 的 base/target 哈希 ---------- */
static uint16_t *fbuf;
static uint32_t fbuf_hash;
static int fbuf_valid;

static void rgb_to_bgr565(const uint8_t *rgb, uint16_t *out) {
  for (size_t i = 0, n = WIDTH * HEIGHT; i < n; i++) {
    unsigned r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
    out[i] = (uint16_t)(((b & 0xF8) << 8) | ((g & 0xFC) << 3) | (r >> 3));
  }
}

/* 整帧：BEGIN + 每 512 KB 一块 LZ4 的 DATA + COMMIT(flags=1 允许后续 patch)
 *
 * 为什么不发“一个整帧 LZ4 块”：固件 `valid_header()` 要求 `h->length <= QD_BLOCK_BYTES(512000)`，
 * 压缩后超过 512 KB 的整帧会被**静默丢弃**（没有任何 ACK）→ 主机侧看起来就是
 * `no-ack-data` + 屏停在等待页（内容丰富/带走势图的画面很容易爆这个上限）。
 * 改成按块压缩：每块 raw=512000（= QD_BLOCK_BYTES 上限）、codec=LZ4，固件逐块解到
 * framebuffer 对应偏移，既不会超限，单包也更小、更好重试。
 */
/* 推一帧；raw_mode=1 时不压缩（flags=0 裸块），作为接收异常的兜底。
 * 返回 0=成功 / 1=设备没 ACK（可重试）/ -1=写失败（链路已死） */
/* 整帧 LZ4 块以前偶发 status=8（同一画面必现），2026-11 定位到不是解码器：
 * `32 + clen` 正好是 512 的整数倍时，HCD 补的 ZLP 会被固件接收路径漏掉。
 * send_cmd 的 raw_write_all() 已把这种长度拆成 len-1 + 1；这里保留坏块哈希 /
 * 裸块兜底，防其它接收异常。 */
static uint32_t bad_blocks[8];
static int bad_count;
static double lz4_bad_until;  /* 最近踩过 LZ4 的坑：这段时间整帧直接发裸块 */

static int block_is_bad(uint32_t h) {
  for (int i = 0; i < bad_count; i++)
    if (bad_blocks[i] == h) return 1;
  return 0;
}

static void remember_bad(uint32_t h) {
  if (block_is_bad(h)) return;
  if (bad_count < (int)(sizeof bad_blocks / sizeof bad_blocks[0])) bad_blocks[bad_count++] = h;
  else memmove(bad_blocks, bad_blocks + 1, sizeof bad_blocks - sizeof bad_blocks[0]), bad_blocks[bad_count - 1] = h;
}

static int push_full_once(link_t *l, int raw_mode, uint32_t *wire, uint32_t *ms) {
  static char *comp;
  static int cap;
  if (!comp) {
    cap = LZ4_compressBound(BLOCK_BYTES);
    comp = malloc((size_t)cap);
    if (!comp) {
      cap = 0;
      return -1;
    }
  }
  double t0 = now_ms();
  uint32_t h = xxh32(fbuf, FRAME_BYTES);
  if (send_cmd(l, QD_BEGIN, 0, 0, FRAME_BYTES, NULL, 0)) return -1;
  if (wait_ack(l, l->seq, ACK_TRIES) || reply_body[0]) return 1;
  uint32_t sent = 64;
  for (uint32_t off = 0; off < FRAME_BYTES; off += BLOCK_BYTES) {
    uint32_t n = FRAME_BYTES - off < BLOCK_BYTES ? FRAME_BYTES - off : BLOCK_BYTES;
    const void *payload;
    uint32_t clen;
    int blk_raw = raw_mode;
    if (!blk_raw && block_is_bad(xxh32((const uint8_t *)fbuf + off, n))) {
      raw_mode = 1; /* 这块以前挂过 */
      blk_raw = 1;
    }
    if (blk_raw) {
      payload = (const uint8_t *)fbuf + off;  /* 裸像素：固件 flags=0 直接收 */
      clen = n;
    } else {
      int c = LZ4_compress_default((const char *)fbuf + off, comp, (int)n, cap);
      if (c <= 0 || (uint32_t)c >= n || (uint32_t)c > BLOCK_BYTES) {
        /* 不可压缩块回退到裸像素发送，避免超过固件 512000 字节上限被丢弃 */
        blk_raw = 1;
        payload = (const uint8_t *)fbuf + off;
        clen = n;
      } else {
        payload = comp;
        clen = (uint32_t)c;
      }
    }
    if (send_cmd(l, QD_DATA, blk_raw ? 0 : 1, off, n, payload, clen)) return -1;
    if (wait_ack(l, l->seq, 3) || reply_body[0]) {
      /* 失败时把这块的大小打出来：块序号 / 未压缩 / 实际发出 / 设备状态码 */
      tlog("cs80: data fail block=%u raw=%u clen=%u status=%u mode=%s\n",
              off / BLOCK_BYTES, n, clen, reply_body[0], blk_raw ? "raw" : "lz4");
      if (!blk_raw) {
        remember_bad(xxh32((const uint8_t *)fbuf + off, n));
        lz4_bad_until = now_ms() + 120000;
      }
      return 1;
    }
    sent += clen + 32;
  }
  if (send_cmd(l, QD_COMMIT, 1, h, 0, NULL, 0)) return -1;
  if (wait_ack(l, l->seq, ACK_TRIES) || reply_body[0]) return 1;
  fbuf_hash = h;
  fbuf_valid = 1;
  *wire = sent + 32;
  *ms = elapsed_ms(t0);
  return 0;
}

/* 整帧：先 LZ4；设备没 ACK 就原地重试（不重启 sidecar），最后一遍改发不压缩的裸块。
 * 裸块长度 512032 不是 512 整数倍，以前是绕过 ZLP 接收 bug 的手段；现在 send_cmd
 * 已统一拆包，裸块只作为最后兜底。只有连裸块都不行才真正判定链路丢失。 */
static int push_full(link_t *l, uint32_t *wire, uint32_t *ms) {
  /* 尝试顺序：LZ4（快）→ 裸块（2 MB，~200 ms）→ 再 LZ4（万一裸块反而过不去）。
   * 接收超时时固件 3 s 才回 status=8；裸块 512032 不是 512 整数倍，能绕过 ZLP 坑。
   * USB 全速（12 Mbps）下 2 MB 裸块 ≈1.7 s，而 LZ4 踩坑要 3 s 超时 + 再发 1.7 s；
   * host 检测到 speed<480 会设 CS80_RAW_FULL=1，直接走裸块。 */
  int skip_lz4 = now_ms() < lz4_bad_until || getenv("CS80_RAW_FULL") != NULL;
  for (int attempt = 0; attempt < 3; attempt++) {
    int raw_mode = attempt == 1 ? 1 : (attempt == 0 ? skip_lz4 : 0);
    double t_attempt = now_ms();
    int r = push_full_once(l, raw_mode, wire, ms);
    if (r == 0) return 0;
    if (r < 0) break;
    tlog("cs80: full frame retry %d (raw=%d, %.0fms)\n", attempt + 1, raw_mode, now_ms() - t_attempt);
    sleep_ms(300);
  }
  link_lost("no-ack-data");
  return -1;
}

static void rollback_patch_fbuf(const uint8_t *tiles, const uint8_t *bak, uint32_t count) {
  for (uint32_t i = count; i-- > 0;) {
    const uint8_t *t = tiles + i * TILE_MSG;
    uint16_t x = (uint16_t)(t[0] | t[1] << 8), y = (uint16_t)(t[2] | t[3] << 8);
    for (uint32_t row = 0; row < TILE_H; row++)
      memcpy((uint8_t *)fbuf + ((y + row) * WIDTH + x) * 2u, bak + i * TILE_BYTES + row * TILE_W * 2u,
             TILE_W * 2u);
  }
}

/* 局部：tile 列表 → 应用到影子 → PATCH(offset=旧哈希) */
static int push_patch(link_t *l, const uint8_t *tiles, uint32_t count, uint32_t *wire, uint32_t *ms) {
  static uint8_t *raw;
  static char *comp;
  static uint8_t *bak;  /* 影子回滚用：失败时把 tile 原来的像素放回去 */
  static int cap;
  if (!fbuf_valid) return -1;
  uint32_t raw_len = 8 + count * (TILE_BYTES + 8);
  if (count == 0) return 1;
  if (count > MAX_TILES) return -2;
  for (uint32_t i = 0; i < count; i++) {
    const uint8_t *t = tiles + i * TILE_MSG;
    uint16_t x = (uint16_t)(t[0] | t[1] << 8), y = (uint16_t)(t[2] | t[3] << 8);
    if ((x & 31u) || (y & 15u) || x >= WIDTH || y >= HEIGHT) return -4;
  }
  if (!raw || !comp || !bak) {
    cap = LZ4_compressBound(BLOCK_BYTES);
    raw = malloc(BLOCK_BYTES);
    comp = malloc((size_t)cap);
    bak = malloc((size_t)MAX_TILES * TILE_BYTES);
    if (!raw || !comp || !bak) {
      free(raw);
      free(comp);
      free(bak);
      raw = NULL;
      comp = NULL;
      bak = NULL;
      cap = 0;
      return -3;
    }
  }
  if (debug) fprintf(stderr, "patch: count=%u fbuf_valid=%d hash=%#x\n", count, fbuf_valid, fbuf_hash);
  wr32(raw, 0); /* target 哈希稍后填 */
  uint8_t *out = raw + 8;
  for (uint32_t i = 0; i < count; i++) {
    const uint8_t *t = tiles + i * TILE_MSG;
    uint16_t x = (uint16_t)(t[0] | t[1] << 8), y = (uint16_t)(t[2] | t[3] << 8);
    out[0] = t[0];
    out[1] = t[1];
    out[2] = t[2];
    out[3] = t[3];
    out[4] = TILE_W;
    out[5] = 0;
    out[6] = TILE_H;
    out[7] = 0;
    memcpy(out + 8, t + 4, TILE_BYTES);
    /* 同步到影子 framebuffer（先备份原像素，失败时回滚） */
    for (uint32_t row = 0; row < TILE_H; row++) {
      uint8_t *dst = (uint8_t *)fbuf + ((y + row) * WIDTH + x) * 2u;
      memcpy(bak + i * TILE_BYTES + row * TILE_W * 2u, dst, TILE_W * 2u);
      memcpy(dst, t + 4 + row * TILE_W * 2u, TILE_W * 2u);
    }
    out += 8 + TILE_BYTES;
  }
  uint32_t target = xxh32(fbuf, FRAME_BYTES);
  wr32(raw, target);
  wr32(raw + 4, count);
  double t0 = now_ms();
  int clen = LZ4_compress_default((const char *)raw, comp, (int)raw_len, cap);
  if (clen <= 0 || (uint32_t)clen > BLOCK_BYTES) {
    rollback_patch_fbuf(tiles, bak, count);
    return -5;
  }
  /* status=8 是设备接收超时。以前偶发的原因是一次写正好 512 整数倍（ZLP 接收 bug），
   * send_cmd 已拆包；这里保留一次原地重试兜底（base 哈希没变，设备也没应用）。 */
  int rc = -7, attempt = 0;
  for (; attempt < 2; attempt++) {  /* 1 次重试；再失败就交给整帧复位 */
    if (attempt) sleep_ms(250);
    if (send_cmd(l, QD_PATCH, 1, fbuf_hash, raw_len, comp, (uint32_t)clen)) link_lost("write-patch");
    if (wait_ack(l, l->seq, ACK_TRIES)) link_lost("no-ack-patch");
    if (debug)
      fprintf(stderr, "patch ack: try=%d status=%u detail=%#x\n", attempt, reply_body[0], reply_body[5]);
    if (reply_body[0] == 0) {
      rc = 0;
      break;
    }
    /* 4=base 哈希不对 / 3=哈希错：重试也没用，直接交给整帧 */
    if (reply_body[0] != 8 && reply_body[0] != 5) break;
    tlog("cs80: patch retry %d (status=%u tiles=%u)\n", attempt + 1, reply_body[0], count);
  }
  *wire = (uint32_t)clen + 32;
  *ms = elapsed_ms(t0);
  if (*ms > 500)  /* 设备偶尔 2~3 s 才回 ACK：留证据（4=base 哈希不对，8=接收超时） */
    tlog("cs80: slow patch ack %ums status=%u tiles=%u clen=%d rx=%u dec=%u draw=%u heap=%u\n", *ms,
         reply_body[0], count, clen, reply_body[1], reply_body[2], reply_body[3], reply_body[4]);
  if (rc == 0) {
    if (reply_body[5] && reply_body[5] != target) {
      /* 设备上的 framebuffer 和设备自己算的哈希对不上：影子已不可信，整帧重来 */
      tlog("cs80: patch hash mismatch device=%#x shadow=%#x\n", reply_body[5], target);
      fbuf_valid = 0;
      return -8;
    }
    fbuf_hash = target;
    return 0;
  }
  /* 失败：把刚才写进影子的 tile 回滚，保持 fbuf_valid=1。
   * 这样浏览器保留 prev 后重试同一块 patch 即可，不必每失败一次就推 2 MB 整帧。 */
  rollback_patch_fbuf(tiles, bak, count);
  return -7;
}

/* ---------- 音频：固件 type 7（控制）/ 8（MP3 分块）/ 9（实时 PCM）----------
 *
 * 固件 0.3.0 的 features=0x23f 已经包含 bit2（文件音频）和 bit3（PCM），PA 使能
 * （QL GPIO22）由固件渲染任务管理，主机侧只需要把 MP3 传进去再触发播放。
 * ACK 的 6 个 u32 在音频命令里被复用为状态字段，这里原样透传给上层。
 */
static uint32_t audio_n;

static void audio_reply(uint8_t sub, const char *err, double t0) {
  if (err)
    json("{\"event\":\"audio\",\"n\":%u,\"sub\":%u,\"ok\":0,\"err\":\"%s\"}", ++audio_n, sub, err);
  else
    json("{\"event\":\"audio\",\"n\":%u,\"sub\":%u,\"ok\":%d,\"status\":%u,\"rx\":%u,\"dec\":%u,"
         "\"draw\":%u,\"detail\":%u,\"ms\":%u}",
         ++audio_n, sub, reply_body[0] == 0, reply_body[0], reply_body[1], reply_body[2], reply_body[3],
         reply_body[5], elapsed_ms(t0));
}

static int audio_cmd(link_t *l, uint8_t sub, uint32_t offset, uint32_t raw, const void *payload, uint32_t len) {
  double t0 = now_ms();
  if (send_cmd(l, QD_AUDIO, sub, offset, raw, payload, len)) link_lost("write-audio");
  if (wait_ack(l, l->seq, ACK_TRIES)) {
    audio_reply(sub, "timeout", t0);
    return -1;
  }
  audio_reply(sub, NULL, t0);
  return reply_body[0] ? -2 : 0;
}

static int audio_data(link_t *l, uint32_t offset, const uint8_t *payload, uint32_t len) {
  double t0 = now_ms();
  if (send_cmd(l, QD_AUDIO_DATA, 0, offset, len, payload, len)) link_lost("write-audio-data");
  if (wait_ack(l, l->seq, ACK_TRIES)) {
    json("{\"event\":\"audio-data\",\"n\":%u,\"ok\":0,\"offset\":%u,\"err\":\"timeout\"}", ++audio_n, offset);
    return -1;
  }
  json("{\"event\":\"audio-data\",\"n\":%u,\"ok\":%d,\"status\":%u,\"offset\":%u,\"sent\":%u,\"detail\":%u,\"ms\":%u}",
       ++audio_n, reply_body[0] == 0, reply_body[0], offset, len, reply_body[5],
       elapsed_ms(t0));
  return reply_body[0] ? -2 : 0;
}

static int audio_pcm(link_t *l, const uint8_t *payload, uint32_t len) {
  double t0 = now_ms();
  if (send_cmd(l, QD_PCM, 0, 0, len, payload, len)) link_lost("write-pcm");
  if (wait_ack(l, l->seq, ACK_TRIES)) {
    json("{\"event\":\"pcm\",\"n\":%u,\"ok\":0,\"err\":\"timeout\"}", ++audio_n);
    return -1;
  }
  json("{\"event\":\"pcm\",\"n\":%u,\"ok\":%d,\"status\":%u,\"detail\":%u,\"ms\":%u}", ++audio_n,
       reply_body[0] == 0, reply_body[0], reply_body[5], elapsed_ms(t0));
  return reply_body[0] ? -2 : 0;
}

static int read_exact(void *buf, size_t len) {
  uint8_t *p = buf;
  while (len) {
    /* Windows 的 _read 返回 int、POSIX 的 read 返回 ssize_t；
       这里单次长度最大是一帧 2 MB，用 int 接两边都能编。 */
    int n = (int)read(0, p, (unsigned)len);
#ifndef _WIN32
    if (n < 0 && errno == EINTR && !stop) continue;
#endif
    if (n <= 0) return -1;
    p += n;
    len -= (size_t)n;
  }
  return 0;
}

static void json(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  putchar('\n');
  fflush(stdout);
}

int main(int argc, char **argv) {
  int iface = 32;
  const char *env = getenv("CS80_IFACE");
  if (env) iface = atoi(env);
  debug = getenv("CS80_DEBUG") != NULL;
  const char *probe = NULL;
  const char *hello = NULL;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--com") && i + 1 < argc) arg_com = argv[++i];
    else if (!strcmp(argv[i], "--probe")) probe = "1";
    else if (!strcmp(argv[i], "--hello")) {
      hello = "1";
      if (i + 1 < argc && !strncmp(argv[i + 1], "COM", 3)) arg_com = argv[++i];
    }
  }
  if (hello) { /* 只验一个端口（host 用来排除注册表里残留的旧 COM） */
    link_t t;
    memset(&t, 0, sizeof t);
    if (open_link(&t, iface)) {
      printf("{\"com\":\"%s\",\"qdc1\":false,\"err\":\"open\"}\n", arg_com ? arg_com : "");
      return 1;
    }
    reply_body[0] = reply_body[5] = 0;
    send_cmd(&t, QD_HELLO, 0, 0, 0, NULL, 0);
    int ok = !wait_ack(&t, t.seq, 3) && reply_body[0] == 0;
    printf("{\"com\":\"%s\",\"qdc1\":%s,\"block\":%u}\n", arg_com ? arg_com : "",
           ok ? "true" : "false", ok ? reply_body[5] : 0);
    close_link(&t);
    return ok ? 0 : 1;
  }
  if (probe) { /* 逐个端口发 HELLO，找出哪个是 QDC1 数据口 */
    int hits = 0;
#ifdef _WIN32
    char name[16];
    for (int i = 3; i < 64; i++) {
      snprintf(name, sizeof name, "COM%d", i);
      arg_com = name;
      link_t t;
      memset(&t, 0, sizeof t);
      if (open_link(&t, iface)) continue;
      reply_body[0] = reply_body[5] = 0;
      send_cmd(&t, QD_HELLO, 0, 0, 0, NULL, 0);
      int ok = !wait_ack(&t, t.seq, 3) && reply_body[0] == 0;
      printf("{\"com\":\"%s\",\"qdc1\":%s,\"block\":%u}\n", name, ok ? "true" : "false", ok ? reply_body[5] : 0);
      if (ok) { hits++; fprintf(stderr, "cs80: QDC1 在 %s（设 CS80_COM=%s 即可）\n", name, name); }
      close_link(&t);
    }
#else
    fprintf(stderr, "cs80: --probe 只在 Windows 有意义（macOS 用接口 32，见 --hello）\n");
#endif
    return hits ? 0 : 1;
  }

  link_t l;
  memset(&l, 0, sizeof l);
  int rc = open_link(&l, iface);
  if (rc) {
    tlog("cs80: 打不开设备 (code=%d)。检查上电/固件/驱动\n", rc);
    return 1;
  }
  g_link = &l;
  fbuf = malloc(FRAME_BYTES);
  uint8_t *rgb = malloc(FRAME_RGB);
  if (!fbuf || !rgb) {
    free(fbuf);
    free(rgb);
    fbuf = NULL;
    close_link(&l);
    return 1;
  }
  signal(SIGINT, on_signal);
#ifndef _WIN32
  signal(SIGPIPE, SIG_IGN);
#else
  _setmode(0, _O_BINARY); /* stdin 走二进制，否则 0x1A/0x0D 会被改写 */
#endif

  /* 握手；老固件/新固件都只是给个块大小与特性位。
   *
   * 刚插上 Type-C 时固件还要跑完自己的 USB 初始化（实测 2–5 s 内 QDC1 一个字节都不回），
   * 以前"打开接口→立刻 HELLO"把这段当成链路丢失 → 整个 sidecar 重启一轮，白折腾。
   * 现在最多重试 10 s，真不通才交给 host 重新枚举。 */
  int handshook = 0;
  for (int i = 0; i < 10 && !stop; i++) {
    if (send_cmd(&l, QD_HELLO, 0, 0, 0, NULL, 0)) break;
    if (!wait_ack(&l, l.seq, 2)) {
      handshook = 1;
      break;
    }
    sleep_ms(1000);
  }
  if (!handshook) link_lost("no-ack-hello");
  json("{\"event\":\"ready\",\"block\":%u,\"status\":%u}", reply_body[5], reply_body[0]);
  if (send_cmd(&l, QD_HELLO, 2, 0, 0, NULL, 0) == 0 && !wait_ack(&l, l.seq, 20))
    json("{\"event\":\"features\",\"bits\":%u}", reply_body[5]);

  static uint8_t *tiles;
  static uint8_t *abuf;
  static uint8_t *dbuf;
  static uint8_t *pbuf;
  while (!stop) {
    if (!wait_stdin(1500)) {
      /* 固件 5 s 收不到主机命令就自己画「等待连接」页 → 空闲保活 */
      if (send_cmd(&l, QD_HELLO, 0, 0, 0, NULL, 0) || wait_ack(&l, l.seq, 4)) link_lost("no-ack-keepalive");
      json("{\"event\":\"keepalive\"}");
      continue;
    }
    uint8_t type;
    if (read_exact(&type, 1)) break;

    if (type == 0x01) { /* 整帧 RGB888 */
      if (read_exact(rgb, FRAME_RGB)) break;
      double t0 = now_ms();
      rgb_to_bgr565(rgb, fbuf);
      uint32_t wire = 0, ms = 0;
      int r = push_full(&l, &wire, &ms);
      json("{\"event\":\"frame\",\"ok\":%d,\"wire\":%u,\"ms\":%u,\"convert_ms\":%u}", r == 0, wire, ms,
           elapsed_ms(t0));
    } else if (type == 0x04) { /* 屏保整帧：已经是 BGR565，省掉一次转换 */
      if (read_exact(fbuf, FRAME_BYTES)) break;
      uint32_t wire = 0, ms = 0;
      int r = push_full(&l, &wire, &ms);
      json("{\"event\":\"saver\",\"ok\":%d,\"wire\":%u,\"ms\":%u}", r == 0, wire, ms);
    } else if (type == 0x02) { /* 局部 tile */
      uint32_t count = 0;
      if (read_exact(&count, 4)) break;
      if (count > MAX_TILES) {
        json("{\"event\":\"patch\",\"ok\":0,\"err\":\"too-many-tiles\"}");
        break;
      }
      if (!tiles) tiles = malloc((size_t)MAX_TILES * TILE_MSG);
      if (!tiles) break;
      if (read_exact(tiles, (size_t)count * TILE_MSG)) break;
      uint32_t wire = 0, ms = 0;
      int r = push_patch(&l, tiles, count, &wire, &ms);
      json("{\"event\":\"patch\",\"n\":%u,\"ok\":%d,\"code\":%d,\"status\":%u,\"tiles\":%u,\"wire\":%u,\"ms\":%u,\"rx\":%u,\"dec\":%u,\"draw\":%u,\"heap\":%u}", ++patch_n, r == 0, r,
           reply_body[0], count, wire, ms, reply_body[1], reply_body[2], reply_body[3], reply_body[4]);
      if (r == -1) json("{\"event\":\"hint\",\"msg\":\"need full frame first\"}");
      /* 限速：给别人家的固件留出绘制时间。正常情况下浏览器 5 Hz（200 ms 一条）
       * 碰不到这个下限；但设备卡顿积压时，这里能防止 sidecar 一口气把几十条 patch
       * 灌进去 → 固件接收超时（status=8）→ 越积越多。 */
      if (r == 0) sleep_ms(50);
    } else if (type == 0x03) { /* 控屏 */
      uint8_t cmd = 0, arg = 0;
      if (read_exact(&cmd, 1) || read_exact(&arg, 1)) break;
      if (cmd == CTL_BRIGHTNESS) {
        if (send_cmd(&l, QD_HELLO, 11, arg, 0, NULL, 0) || wait_ack(&l, l.seq, ACK_TRIES))
          link_lost("no-ack-brightness");
        json("{\"event\":\"brightness\",\"ok\":%d,\"value\":%u}", reply_body[0] == 0, reply_body[5]);
      } else if (cmd == CTL_SLEEP || cmd == CTL_WAKE) {
        if (send_cmd(&l, QD_HELLO, 18, cmd == CTL_SLEEP ? 1 : 0, 0, NULL, 0) || wait_ack(&l, l.seq, ACK_TRIES))
          link_lost("no-ack-power");
        json("{\"event\":\"power\",\"ok\":%d,\"awake\":%u}", reply_body[0] == 0, reply_body[1]);
      } else if (cmd == CTL_STATE) {
        if (send_cmd(&l, QD_HELLO, 10, 0, 0, NULL, 0) || wait_ack(&l, l.seq, ACK_TRIES))
          link_lost("no-ack-state");
        uint32_t brightness = reply_body[1], backlight = reply_body[2], edges = reply_body[3], detail = reply_body[5];
        json("{\"event\":\"state\",\"brightness\":%u,\"backlight\":%u,\"edges\":%u,\"detail\":%u}", brightness,
             backlight, edges, detail);
      } else if (cmd == CTL_HELLO) {
        send_cmd(&l, QD_HELLO, 0, 0, 0, NULL, 0);
        wait_ack(&l, l.seq, 40);
        json("{\"event\":\"hello\",\"block\":%u}", reply_body[5]);
      } else {
        json("{\"event\":\"control\",\"ok\":0,\"err\":\"unknown-cmd\"}");
      }
    } else if (type == 0x05) { /* 音频控制（type 7） */
      uint8_t h[16];
      if (read_exact(h, sizeof h)) break;
      uint8_t sub = h[0];
      uint32_t len = rd32(h + 4), offset = rd32(h + 8), raw = rd32(h + 12);
      if (len > AUDIO_CHUNK) {
        json("{\"event\":\"audio\",\"sub\":%u,\"ok\":0,\"err\":\"too-large\"}", sub);
        break;
      }
      if (!abuf) abuf = malloc(AUDIO_CHUNK);
      if (!abuf) break;
      if (len && read_exact(abuf, len)) break;
      audio_cmd(&l, sub, offset, raw, len ? abuf : NULL, len);
    } else if (type == 0x06) { /* MP3 上传块（type 8） */
      uint8_t h[8];
      if (read_exact(h, sizeof h)) break;
      uint32_t offset = rd32(h), len = rd32(h + 4);
      if (!len || len > AUDIO_CHUNK) {
        json("{\"event\":\"audio-data\",\"ok\":0,\"err\":\"bad-length\"}");
        break;
      }
      if (!dbuf) dbuf = malloc(AUDIO_CHUNK);
      if (!dbuf) break;
      if (read_exact(dbuf, len)) break;
      audio_data(&l, offset, dbuf, len);
    } else if (type == 0x07) { /* 实时 PCM（type 9） */
      uint32_t len = 0;
      if (read_exact(&len, 4)) break;
      if (!len || len > AUDIO_CHUNK || (len & 1u)) {
        json("{\"event\":\"pcm\",\"ok\":0,\"err\":\"bad-length\"}");
        break;
      }
      if (!pbuf) pbuf = malloc(AUDIO_CHUNK);
      if (!pbuf) break;
      if (read_exact(pbuf, len)) break;
      audio_pcm(&l, pbuf, len);
    } else {
      fprintf(stderr, "cs80: 未知消息类型 %#x\n", type);
      break;
    }
  }
  close_link(&l);
  free(tiles);
  free(abuf);
  free(dbuf);
  free(pbuf);
  free(fbuf);
  free(rgb);
  json("{\"event\":\"exit\"}");
  return 0;
}
