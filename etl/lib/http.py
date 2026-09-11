"""下載工具：一律走 curl。

★ 為什麼不用 urllib（nhi-drug-rules 的做法）：
  本機 uv 安裝的 Python 沒有系統 CA bundle，urllib 對 ftp.cdc.gov / nlm.nih.gov
  直接 CERTIFICATE_VERIFY_FAILED；CI 的 Ubuntu 又沒事 —— 同一支程式兩邊行為不同。
  curl 用系統憑證，本機與 CI 一致，也不必為了下載動 venv 依賴。

★ range 抓取：CDC 伺服器實測約 12 KB/s，整包 zip 21.7 MB（大半是 PDF）要半小時。
  讀 zip 的 central directory 後只抓需要的 XML 成員，約 60 秒。
"""

from __future__ import annotations

import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import USER_AGENT  # noqa: E402


def _curl(args: list[str], timeout: int) -> bytes:
    r = subprocess.run(["curl", "-sSfL", "-A", USER_AGENT, "--max-time", str(timeout), *args],
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"curl 失敗 rc={r.returncode}: {r.stderr.decode(errors='ignore')[:200]}")
    return r.stdout


def fetch(url: str, *, retries: int = 4, timeout: int = 600) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            return _curl([url], timeout)
        except RuntimeError as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"下載失敗 {url}: {last}")


def download(url: str, dest: Path, **kw) -> int:
    """先寫 .part 再 rename：中斷的半個檔案絕不能被下游當成完整資料。"""
    data = fetch(url, **kw)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return len(data)


def content_length(url: str) -> int:
    """★ 一定要看最終狀態碼：NLM 對不存在的 desc2027.gz 回 404 頁，那頁也有
    Content-Length —— 只抓數字會把「明年的檔還沒出」當成存在，下載到 0 MB 的錯誤頁。"""
    head = subprocess.run(["curl", "-sSIL", "-A", USER_AGENT, "--max-time", "60", url],
                          capture_output=True, text=True).stdout
    blocks = [b for b in head.replace("\r", "").split("\n\n") if b.strip()]
    if not blocks:
        raise RuntimeError(f"HEAD 無回應：{url}")
    last = blocks[-1].splitlines()
    status = int(last[0].split()[1]) if last and last[0].startswith("HTTP") else 0
    if status != 200:
        raise RuntimeError(f"HTTP {status}：{url}")
    sizes = [int(l.split(":", 1)[1]) for l in last if l.lower().startswith("content-length:")]
    if not sizes:
        raise RuntimeError(f"拿不到 Content-Length：{url}")
    return sizes[-1]


def probe(url: str) -> tuple[int, str, int]:
    """(最終狀態碼, content-type, content-length)。

    ★ 光看 200 不夠：NLM 對還沒發布的 desc2027.gz 會 302 到一個 **200 + text/html**
      的 soft-404 頁（16 KB）。判斷「檔案真的存在」要連型別與大小一起看。"""
    head = subprocess.run(["curl", "-sSIL", "-A", USER_AGENT, "--max-time", "60", url],
                          capture_output=True, text=True).stdout
    blocks = [b for b in head.replace("\r", "").split("\n\n") if b.strip()]
    if not blocks:
        return 0, "", 0
    last = blocks[-1].splitlines()
    status = int(last[0].split()[1]) if last and last[0].startswith("HTTP") else 0
    kv = {l.split(":", 1)[0].lower(): l.split(":", 1)[1].strip() for l in last[1:] if ":" in l}
    return status, kv.get("content-type", ""), int(kv.get("content-length", "0") or 0)


def fetch_range(url: str, start: int, end: int, *, retries: int = 4) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            b = _curl(["-r", f"{start}-{end}", url], 1800)
            if len(b) != end - start + 1:
                raise RuntimeError(f"range 長度不符 {len(b)} ≠ {end - start + 1}（伺服器可能不支援 range）")
            return b
        except RuntimeError as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"range 下載失敗 {url} {start}-{end}: {last}")


def zip_members(url: str, names: list[str]) -> dict[str, bytes]:
    """只下載遠端 zip 的指定成員。回傳 {name: 解壓後內容}。"""
    size = content_length(url)
    tail = fetch_range(url, max(0, size - 65536), size - 1)
    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError("找不到 zip EOCD（檔案可能不是 zip 或是 zip64）")
    _n, cd_size, cd_off = struct.unpack("<HII", tail[eocd + 10:eocd + 20])
    base = size - len(tail)
    cd = tail[cd_off - base:cd_off - base + cd_size] if cd_off >= base else fetch_range(url, cd_off, cd_off + cd_size - 1)
    entries: dict[str, tuple[int, int, int]] = {}
    p = 0
    while cd[p:p + 4] == b"PK\x01\x02":
        meth, = struct.unpack("<H", cd[p + 10:p + 12])
        csize, = struct.unpack("<I", cd[p + 20:p + 24])
        nl, el, cl = struct.unpack("<HHH", cd[p + 28:p + 34])
        off, = struct.unpack("<I", cd[p + 42:p + 46])
        entries[cd[p + 46:p + 46 + nl].decode("utf-8", "replace")] = (meth, csize, off)
        p += 46 + nl + el + cl
    out: dict[str, bytes] = {}
    for name in names:
        if name not in entries:
            raise RuntimeError(f"zip 裡沒有 {name}；實際成員：{sorted(entries)}")
        meth, csize, off = entries[name]
        lh = fetch_range(url, off, off + 29)
        nl, el = struct.unpack("<HH", lh[26:30])
        data = fetch_range(url, off + 30 + nl + el, off + 30 + nl + el + csize - 1)
        out[name] = zlib.decompress(data, -15) if meth == 8 else data
    return out
