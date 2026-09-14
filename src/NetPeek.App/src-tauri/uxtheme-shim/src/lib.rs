//! 让本进程的原生弹出菜单（托盘右键菜单走的就是 `TrackPopupMenu`）跟随应用深浅。
//!
//! ## 为什么单独一个 crate
//!
//! `SetPreferredAppMode` / `FlushMenuThemes` 在 uxtheme.dll 里**只有序号没有名字**
//! （135 / 136），取它们必须 `GetProcAddress(135 as *const u8)` 再把裸指针
//! `transmute` 成函数指针 —— 躲不开 `unsafe`。而 `netpeek-app` 的 `Cargo.toml`
//! 写着 `unsafe_code = "forbid"`（工程约束取自 Sniffnet），且 `forbid` 连子模块上的
//! `#[allow]` 都盖不住。于是把这几行 unsafe 关进这个零依赖的小 crate，
//! 主 crate 一个 `unsafe` 都不出现，口子只留在这一处、且有明确边界。
//!
//! ## 为什么是这两个函数
//!
//! 原生弹出菜单由系统绘制，应用层没有「给某个菜单上色」的接口：
//! muda 的 `set_theme_for_hwnd` 只作用于**窗口菜单栏**，它自己的 Windows 实现里
//! 连 `SetPreferredAppMode` 都没调用过（源码核对见 `docs/开发进度.md` §37）。
//! 能影响的只有这一个进程级开关 —— 「我希望被当成深色还是浅色应用」——
//! 而它改完必须 `FlushMenuThemes` 把菜单主题缓存冲掉，下一次弹菜单才会用新颜色。
//!
//! 这套做法在生产里验证过：微软 PowerToys 给 ZoomIt 做「托盘菜单跟随系统主题」
//! 用的就是 ordinal 135 + 136（`src/common/Themes/dark_menu.h`），
//! 结论是「系统画出真正的主题化菜单，键盘 / 无障碍 / 勾选 / 分隔线 / DPI 全保留，
//! 只有颜色变」。Emacs 的 w32 深色模式补丁是同一条路。

#![deny(unsafe_op_in_unsafe_fn)]

use std::sync::atomic::{AtomicU8, Ordering};

/// 进程级应用模式。
///
/// 只暴露 `Force*` 两种，不暴露 uxtheme 枚举里的 `Default` / `AllowDark`：
/// 本应用的主题可以跟系统设置无关（皮肤里能把深浅方向钉死），
/// 所以「跟随系统」在这里没有意义 —— 深浅的答案由皮肤引擎给出。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AppMode {
    Dark,
    Light,
}

impl AppMode {
    /// uxtheme 的 `PreferredAppMode` 数值（ABI，不能改）：
    /// `Default=0, AllowDark=1, ForceDark=2, ForceLight=3, Max=4`。
    fn raw(self) -> u8 {
        match self {
            AppMode::Dark => 2,
            AppMode::Light => 3,
        }
    }
}

/// 上一次真的写进系统的值（0 = 还没写过）。用来做「值没变就不写」的去重。
static APPLIED: AtomicU8 = AtomicU8::new(0);

/// 写一次，但值没变就什么都不做。返回这次有没有真的写进系统。
///
/// 去重是为了调用方：主题滑杆拖一下会连着上报几十次同一个值，
/// 每次都 `FlushMenuThemes` 是白扔的（虽然代价很小）。
pub fn set_app_mode(mode: AppMode) -> bool {
    if APPLIED.load(Ordering::SeqCst) == mode.raw() {
        return false;
    }
    let wrote = write(mode);
    // 只在真的写成功时记录：uxtheme 取不到（Windows 10 1809 之前没有这两个序号）
    // 就不该让「已生效」这个假状态留在缓存里。
    if wrote {
        APPLIED.store(mode.raw(), Ordering::SeqCst);
    }
    wrote
}

/// 无条件重写一次。给「菜单弹出前」这个场景用：`TrackPopupMenu` 取的是弹出那一刻的
/// 系统状态，而正常的写入发生在主题变化时（可能几分钟前），重写是唯一能保证新鲜的做法。
pub fn reassert_app_mode(mode: AppMode) -> bool {
    let wrote = write(mode);
    if wrote {
        APPLIED.store(mode.raw(), Ordering::SeqCst);
    }
    wrote
}

/// 本进程能不能改这个开关（Windows 10 1809 / 17763 以前取不到那两个序号）。
pub fn supported() -> bool {
    imp::load().is_some()
}

#[cfg(windows)]
fn write(mode: AppMode) -> bool {
    let Some(ordinals) = imp::load() else {
        return false;
    };
    // SAFETY: 两个函数指针都来自 uxtheme.dll 里序号 135 / 136 的导出，
    // 签名照 ABI 声明（`fn(i32) -> i32` / `fn()`）；`mode.raw()` 只会是 2 或 3，
    // 都在 `PreferredAppMode` 的合法区间内。调用不涉及任何我们持有的内存。
    unsafe {
        (ordinals.set)(i32::from(mode.raw()));
        (ordinals.flush)();
    }
    true
}

#[cfg(not(windows))]
fn write(_mode: AppMode) -> bool {
    false
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    /// `PreferredAppMode SetPreferredAppMode(PreferredAppMode)` —— 返回值是上一次的模式，
    /// 我们不用它，签名照 ABI 抄。
    type SetPreferredAppModeFn = unsafe extern "system" fn(i32) -> i32;
    /// `void FlushMenuThemes(void)`。
    type FlushMenuThemesFn = unsafe extern "system" fn();

    pub struct Ordinals {
        pub set: SetPreferredAppModeFn,
        pub flush: FlushMenuThemesFn,
    }

    /// 序号从 Windows 10 1809（build 17763）起才指向这两个函数；更早的版本 135 是
    /// `AllowDarkModeForApp`（签名不同），拿到就调会崩。取不到就整体放弃。
    const SET_PREFERRED_APP_MODE: usize = 135;
    const FLUSH_MENU_THEMES: usize = 136;

    // 只声明要用的三个 kernel32 函数，不引 windows-sys。
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }

    /// uxtheme 的模块句柄：`GetModuleHandleW` 命中不了（进程还没加载它）就 `LoadLibraryW`。
    fn module() -> Option<*mut c_void> {
        let name: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
        // SAFETY: 传的是本函数构造的、以 NUL 结尾的宽字符串；两个函数都不保留它。
        let module = unsafe { GetModuleHandleW(name.as_ptr()) };
        if !module.is_null() {
            return Some(module);
        }
        // SAFETY: 同上。
        let module = unsafe { LoadLibraryW(name.as_ptr()) };
        (!module.is_null()).then_some(module)
    }

    /// 解析两个序号导出。进程内只做一次（失败也缓存）。
    pub fn load() -> Option<&'static Ordinals> {
        static CACHE: OnceLock<Option<Ordinals>> = OnceLock::new();
        CACHE
            .get_or_init(|| {
                let module = module()?;
                // SAFETY: `MAKEINTRESOURCEA(n)` 的定义就是把序号当字符串指针传，
                // 这两个序号在本机 uxtheme 上存在性由返回值判空处理。
                let set = unsafe { GetProcAddress(module, SET_PREFERRED_APP_MODE as *const u8) };
                let flush = unsafe { GetProcAddress(module, FLUSH_MENU_THEMES as *const u8) };
                if set.is_null() || flush.is_null() {
                    return None;
                }
                // SAFETY: 上面已确认非空，且这两个地址确实是指向 uxtheme 里
                // `SetPreferredAppMode` / `FlushMenuThemes` 的代码地址；
                // 按声明好的 `unsafe extern "system"` 签名调用是这套 API 的既定用法
                // （PowerToys / ysc3839/win32-darkmode 同款）。
                Some(Ordinals {
                    set: unsafe { std::mem::transmute::<*mut c_void, SetPreferredAppModeFn>(set) },
                    flush: unsafe { std::mem::transmute::<*mut c_void, FlushMenuThemesFn>(flush) },
                })
            })
            .as_ref()
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 上什么都做不了，但接口保持同名，调用方不用 cfg。
    pub fn load() -> Option<&'static ()> {
        None
    }
}
