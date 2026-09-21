using System.Runtime.InteropServices;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 全系统进程快照：一次 <c>NtQuerySystemInformation(SystemProcessInformation)</c> 拿到
/// 每个 PID 的**名字与启动时间**。
///
/// 为什么需要它（2026-09-21，用户在真实库里发现 491 MB 流量对不上账）：
/// <see cref="ProcessMetadataCache"/> 原来从两个来源取元数据 —— 名字走全系统快照、
/// 启动时间走 <c>OpenProcess</c> + <c>GetProcessTimes</c>。问题就出在这个**不对称**：
/// 句柄开不出来时，代码仍能从快照里捞回名字（那一行在 UI 上看起来完全正常、有名字有图标），
/// 但启动时间退化成 0。而「近 24 小时」列是按 <c>pid:start_ts</c> 查历史库的
///（history.rs 的 minute_stats 主键是 (ts, pid, start_ts)，前端 day24Key 同构），
/// start_ts=0 就把这一行钉死成一个**谁也匹配不上**的身份键：
/// 实时列表里看得见、历史库里也落盘了（字节数是真的），两边的键却对不上，
/// 于是那一列永远是破折号，数据等于消失。
///
/// 实测（用户库 97,407 行，2026-09-21）：start_ts=0 的有 2,387 行、累计约 5.7 GB；
/// 只看最近 24 小时窗口，433 行 / 491 MB。其中 539 行**有名字**——正是本类要消灭的那类行：
/// 名字拿到了、启动时间没拿到。典型受害者是受保护进程（杀软、反作弊、部分服务），
/// 以及「ETW 回调与 OpenProcess 之间进程刚好退出」的短命进程。
///
/// 所以这里不引入新能力，只是把已有的那次快照用足：它本来就要枚举全系统进程，
/// 而 <c>CREATE_TIME</c> 就在同一个结构体里，**不需要按进程开句柄**。
/// 一次调用拿到全部，顺带把「每个 PID 各开一次句柄」的开销也省掉。
///
/// 与 <c>Process.GetProcesses()</c> 的关系：两者底层是同一次系统查询，但托管 API 只暴露
/// 进程名（<c>Process.ProcessName</c> 来自同一份快照的 ImageName），启动时间要通过
/// <c>Process.StartTime</c> 取——那会**再开一次句柄**，正是我们要绕开的东西。
/// 这也是原先「名字走快照、启动时间走句柄」这个不对称的由来。本类把两者合到一次调用里。
/// </summary>
internal static class SystemProcessSnapshot
{
    /// <summary>SystemProcessInformation 的信息类别编号。</summary>
    private const int SystemProcessInformation = 5;

    /// <summary>NTSTATUS 成功。</summary>
    private const int STATUS_SUCCESS = 0;

    /// <summary>缓冲区不足（还在探测所需大小时会看到，属正常）。</summary>
    private const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);

    /// <summary>
    /// 初始缓冲区 1 MB。实测 367 个进程约用 700 KB，1 MB 起步绝大多数情况一次就够。
    /// </summary>
    private const int InitialBufferBytes = 1 << 20;

    /// <summary>
    /// 缓冲区上限 64 MB。这个循环只可能因为「进程数在两次调用之间暴涨」重试，
    /// 正常一次到两次就成功；给上限是为了万一被反复打断也绝不无限分配内存
    ///（常驻服务里没有边界的重试等于内存泄漏）。
    /// </summary>
    private const int MaxBufferBytes = 64 << 20;

    /// <summary>
    /// SYSTEM_PROCESS_INFORMATION 在 x64 上的字段偏移。
    ///
    /// 只取三个字段，且都经 2026-09-21 本机实测校准过（不是照抄文档）：
    /// 用自身进程做对照，`NtQuerySystemInformation` 在 +0x20 读到的值与
    /// `GetProcessTimes` 返回的创建时间**完全相等**（134344304811889064），
    /// 从而确认 CreateTime 在 +0x20、UniqueProcessId 在 +0x50。
    ///
    /// 特意不声明完整结构体：这些偏移是稳定的（Win10 1607 以来未变），而结构体尾部
    /// 随版本增长；只读前 0x58 字节，用「按 NextEntryOffset 走链表 + 定点读字段」
    /// 比声明一个可能过时的大结构体更不容易出错。
    /// </summary>
    private const int OffsetCreateTime = 0x20;      // LARGE_INTEGER，UTC FILETIME
    private const int OffsetUniqueProcessId = 0x50; // HANDLE（低位是 PID）
    private const int OffsetNextEntry = 0x00;       // ULONG，到下一个条目的字节数；0 = 末尾

    /// <summary>
    /// 取出全系统进程快照。失败（含缓冲区始终不足）返回空字典 ——
    /// 调用方必须能接受「这一轮没有快照」，而不是抛异常：
    /// 元数据只是显示用的附加信息，它拿不到不该让整帧流量数据跟着失败。
    /// </summary>
    internal static Dictionary<uint, (string Name, long StartTimeUtcFileTime)> Read()
    {
        var result = new Dictionary<uint, (string, long)>();
        var size = InitialBufferBytes;
        IntPtr buffer = IntPtr.Zero;

        try
        {
            while (size <= MaxBufferBytes)
            {
                buffer = Marshal.AllocHGlobal(size);
                var status = NtQuerySystemInformation(
                    SystemProcessInformation, buffer, size, out var needed);

                if (status == STATUS_SUCCESS)
                {
                    // 快照有效时长以「调用返回」为准：这中间进程可能已经变了，
                    // 但元数据本来就有 TTL，晚一拍读到旧值是可接受的（同 NameIndexTtlMs 的口径）。
                    Parse(buffer, result);
                    return result;
                }

                // 缓冲区不够：按系统给出的 needed 重来。这不是错误，是这类 API 的常规握手。
                Marshal.FreeHGlobal(buffer);
                buffer = IntPtr.Zero;

                if (status != STATUS_INFO_LENGTH_MISMATCH)
                {
                    return result;
                }

                // needed 是「需要的字节数」，留 16KB 余量避免刚好卡在边界再来一轮。
                size = Math.Max(needed + 16 * 1024, size * 2);
            }

            return result;
        }
        catch
        {
            // 原生内存读写对畸形数据不设防：越界读会直接 AV 掉整个服务进程，
            // 而这只是一个显示用的补充信息源，不值得拿服务的命去换。
            // 出任何意外就当作「这一轮没有快照」，下一轮（TTL 到期后）会再试。
            return new Dictionary<uint, (string, long)>();
        }
        finally
        {
            if (buffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    /// <summary>
    /// 按 NextEntryOffset 链表遍历。每个条目的布局：
    /// <c>NextEntryOffset</c> + <c>ImageName</c>(UNICODE_STRING) + <c>CreateTime</c> + <c>UniqueProcessId</c> …
    /// 名字直接从条目内的 UNICODE_STRING 读，不走托管字符串表，避免为此分配整个 Process[]。
    /// </summary>
    private static void Parse(IntPtr buffer, Dictionary<uint, (string Name, long StartTimeUtcFileTime)> into)
    {
        var offset = 0;

        while (true)
        {
            var next = Marshal.ReadInt32(buffer, offset + OffsetNextEntry);
            var pid = (uint)Marshal.ReadInt32(buffer, offset + OffsetUniqueProcessId);

            // PID 0 是 Idle 伪进程、PID 4 是 System —— 两者都不会产生 ETW 网络事件，
            // 收进来只会让字典多两条永远用不上的记录。
            if (pid > 4)
            {
                var createTime = Marshal.ReadInt64(buffer, offset + OffsetCreateTime);
                var name = ReadImageName(buffer, offset, pid);
                into[pid] = (name, createTime);
            }

            // NextEntryOffset == 0 是链表终点。这是唯一的结束条件 ——
            // 条目是按字节紧凑排布的，没有「固定数量」可取。
            if (next == 0)
            {
                return;
            }

            offset += next;
        }
    }

    /// <summary>
    /// 读条目里的 <c>ImageName</c>（UNICODE_STRING：Length / MaximumLength / Buffer 指针）。
    ///
    /// 偏移 0x38 是 x64 上 UNICODE_STRING 的起点（在 CreateTime 0x20 与 KernelTime 之后）。
    /// Buffer 是**指针**，指向这份快照缓冲区之内的名字字符串；Length 是字节数（不是字符数），
    /// 且不含结尾的 NUL。两者任一异常就返回空串 —— 名字缺失只影响显示，
    /// 而启动时间（真正决定身份键的那个字段）不受影响。
    /// </summary>
    private static string ReadImageName(IntPtr buffer, int entryOffset, uint pid)
    {
        // UNICODE_STRING 的布局（x64）：+0 Length(2) / +2 MaximumLength(2) / +4 对齐填充 /
        // +8 Buffer 指针。所以名字指针在起点 +8，长度在起点 +0。
        const int offsetUnicodeString = 0x38;

        try
        {
            var length = (ushort)Marshal.ReadInt16(buffer, entryOffset + offsetUnicodeString);
            if (length == 0 || length > 512 * 2)
            {
                // 长度 0（系统伪进程之类）或大得离谱（数据畸形）都不去读。
                return string.Empty;
            }

            // Buffer 在 UNICODE_STRING 起点的 +8 处（Length/MaximumLength 各 4 字节）。
            var namePtr = Marshal.ReadIntPtr(buffer, entryOffset + offsetUnicodeString + 8);
            if (namePtr == IntPtr.Zero)
            {
                return string.Empty;
            }

            var name = Marshal.PtrToStringUni(namePtr, length / 2);
            return name ?? string.Empty;
        }
        catch
        {
            // 单条名字读坏不影响整份快照：这个名字留空，别的 PID 照常进表
            //（失败的只是显示名，身份键仍然完整）。
            _ = pid;
            return string.Empty;
        }
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(
        int systemInformationClass,
        IntPtr systemInformation,
        int systemInformationLength,
        out int returnLength);
}
