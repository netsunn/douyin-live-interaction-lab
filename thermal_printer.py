import argparse
import ctypes
import io
import urllib.request
from ctypes import wintypes

from PIL import Image, ImageDraw, ImageFont, ImageOps


DEFAULT_PRINTER = "Gprinter iSH58"
PAPER_WIDTH = 384
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"
SYMBOL_FONT_PATH = r"C:\Windows\Fonts\seguisym.ttf"
EMOJI_FONT_PATH = r"C:\Windows\Fonts\seguiemj.ttf"


class DOC_INFO_1(ctypes.Structure):
    _fields_ = [
        ("pDocName", wintypes.LPWSTR),
        ("pOutputFile", wintypes.LPWSTR),
        ("pDatatype", wintypes.LPWSTR),
    ]


def render_receipt(text: str, image_path: str | None = None) -> bytes:
    font = ImageFont.truetype(FONT_PATH, 30)
    symbol_font = ImageFont.truetype(SYMBOL_FONT_PATH, 30) if __import__('os').path.exists(SYMBOL_FONT_PATH) else font
    emoji_font = ImageFont.truetype(EMOJI_FONT_PATH, 30) if __import__('os').path.exists(EMOJI_FONT_PATH) else symbol_font

    def char_font(char: str):
        code = ord(char)
        if code >= 0x1F000 or 0x2600 <= code <= 0x27BF:
            return emoji_font
        if code < 0x20 or (0x2000 <= code <= 0x206F) or (0x2100 <= code <= 0x22FF):
            return symbol_font
        return font

    def text_width(value: str) -> int:
        return sum(draw.textbbox((0, 0), char, font=char_font(char))[2] for char in value)

    probe = Image.new("L", (PAPER_WIDTH, 1), 255)
    draw = ImageDraw.Draw(probe)
    text_margin = 0
    max_width = PAPER_WIDTH - text_margin * 2
    lines = []
    line = ""
    for char in text:
        candidate = line + char
        width = text_width(candidate)
        if line and width > max_width:
            lines.append(line)
            line = char
        else:
            line = candidate
    if line:
        lines.append(line)

    line_height = 36
    text_height = max(40, len(lines) * line_height + 6)
    gift_image = None
    if image_path:
        try:
            if image_path.lower().startswith(('http://', 'https://')):
                request = urllib.request.Request(image_path, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(request, timeout=8) as response:
                    source = Image.open(io.BytesIO(response.read())).convert("L")
            else:
                source = Image.open(image_path).convert("L")
            source = ImageOps.autocontrast(source, cutoff=1)
            source.thumbnail((300, 240), Image.Resampling.LANCZOS)
            gift_image = source.convert("1", dither=Image.Dither.FLOYDSTEINBERG)
        except Exception as error:
            # 头像地址失效时仍打印感谢文字，不让图片问题阻塞整条消息。
            print(f"头像加载失败：{error}", file=__import__('sys').stderr)
            gift_image = None

    image_height = gift_image.height + 8 if gift_image else 0
    image = Image.new("L", (PAPER_WIDTH, image_height + text_height), 255)
    if gift_image:
        image.paste(gift_image, ((PAPER_WIDTH - gift_image.width) // 2, 2))
    draw = ImageDraw.Draw(image)
    for index, value in enumerate(lines):
        x = text_margin
        y = image_height + 2 + index * line_height
        for char in value:
            current_font = char_font(char)
            draw.text((x, y), char, font=current_font, fill=0)
            x += draw.textbbox((0, 0), char, font=current_font)[2]
    image = image.point(lambda value: 0 if value < 170 else 255, mode="1")

    width_bytes = (image.width + 7) // 8
    raster = bytearray()
    pixels = image.load()
    for y in range(image.height):
        for byte_x in range(width_bytes):
            value = 0
            for bit in range(8):
                x = byte_x * 8 + bit
                if x < image.width and pixels[x, y] == 0:
                    value |= 0x80 >> bit
            raster.append(value)
    header = b"\x1dv0\x00" + bytes((width_bytes & 0xFF, width_bytes >> 8, image.height & 0xFF, image.height >> 8))
    return b"\x1b@" + header + bytes(raster) + b"\n"


def raw_print(printer_name: str, text: str, image_path: str | None = None) -> int:
    winspool = ctypes.WinDLL("winspool.drv", use_last_error=True)
    winspool.OpenPrinterW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.HANDLE), wintypes.LPVOID]
    winspool.OpenPrinterW.restype = wintypes.BOOL
    winspool.StartDocPrinterW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPBYTE]
    winspool.StartDocPrinterW.restype = wintypes.DWORD
    winspool.StartPagePrinter.argtypes = [wintypes.HANDLE]
    winspool.StartPagePrinter.restype = wintypes.BOOL
    winspool.WritePrinter.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    winspool.WritePrinter.restype = wintypes.BOOL
    winspool.EndPagePrinter.argtypes = [wintypes.HANDLE]
    winspool.EndDocPrinter.argtypes = [wintypes.HANDLE]
    winspool.ClosePrinter.argtypes = [wintypes.HANDLE]

    handle = wintypes.HANDLE()
    if not winspool.OpenPrinterW(printer_name, ctypes.byref(handle), None):
        raise ctypes.WinError(ctypes.get_last_error())

    doc_started = False
    page_started = False
    try:
        doc_info = DOC_INFO_1("无人直播小票测试", None, "RAW")
        job_id = winspool.StartDocPrinterW(handle, 1, ctypes.cast(ctypes.byref(doc_info), wintypes.LPBYTE))
        if not job_id:
            raise ctypes.WinError(ctypes.get_last_error())
        doc_started = True

        if not winspool.StartPagePrinter(handle):
            raise ctypes.WinError(ctypes.get_last_error())
        page_started = True

        payload = render_receipt(text, image_path)
        buffer = ctypes.create_string_buffer(payload)
        written = wintypes.DWORD()
        if not winspool.WritePrinter(handle, buffer, len(payload), ctypes.byref(written)):
            raise ctypes.WinError(ctypes.get_last_error())
        if written.value != len(payload):
            raise RuntimeError(f"只写入 {written.value}/{len(payload)} 字节")
        return job_id
    finally:
        if page_started:
            winspool.EndPagePrinter(handle)
        if doc_started:
            winspool.EndDocPrinter(handle)
        winspool.ClosePrinter(handle)


def main() -> None:
    parser = argparse.ArgumentParser(description="向 ESC/POS USB 小票打印机打印一句话")
    parser.add_argument("text", nargs="?", default="祝你天天开心，好运常伴！")
    parser.add_argument("--printer", default=DEFAULT_PRINTER)
    parser.add_argument("--image", help="打印在文字上方的图片文件")
    args = parser.parse_args()
    job_id = raw_print(args.printer, args.text.strip(), args.image)
    print(f"已提交打印任务 {job_id}")


if __name__ == "__main__":
    main()
