from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter


SOURCES = [
    ("weapon-5-sword.png", Path(r"C:\Users\Think\AppData\Local\Temp\codex-clipboard-1f473383-54d3-4b93-8554-11b587d03fec.png"), 52),
    ("weapon-4-cleaver.png", Path(r"C:\Users\Think\AppData\Local\Temp\codex-clipboard-f2c4cc98-5afc-4e51-89f3-6994a462eaf1.png"), 34),
    ("weapon-3-mace.png", Path(r"C:\Users\Think\AppData\Local\Temp\codex-clipboard-6eb5162b-04a5-40f0-9d50-fee35e0697ad.png"), 44),
    ("weapon-2-sickle.png", Path(r"C:\Users\Think\AppData\Local\Temp\codex-clipboard-d58f31a1-503b-4832-9ad8-92222cfe6131.png"), 48),
    ("weapon-1-axe.png", Path(r"C:\Users\Think\AppData\Local\Temp\codex-clipboard-0e46f071-9322-4635-b8bf-2e61d3e44a05.png"), 52),
]


def color_distance(a, b):
    return sum((int(a[index]) - int(b[index])) ** 2 for index in range(3)) ** 0.5


def remove_edge_background(source, destination, threshold, keep_polygon=None, special_mask=None):
    image = Image.open(source).convert("RGB")
    width, height = image.size
    pixels = image.load()
    samples = [pixels[2, 2], pixels[width - 3, 2], pixels[2, height - 3], pixels[width - 3, height - 3]]
    visited = bytearray(width * height)
    queue = deque()

    def add(x, y):
        offset = y * width + x
        if visited[offset] or min(color_distance(pixels[x, y], sample) for sample in samples) > threshold:
            return
        visited[offset] = 1
        queue.append((x, y))

    for x in range(width):
        add(x, 0)
        add(x, height - 1)
    for y in range(height):
        add(0, y)
        add(width - 1, y)
    while queue:
        x, y = queue.popleft()
        if x:
            add(x - 1, y)
        if x + 1 < width:
            add(x + 1, y)
        if y:
            add(x, y - 1)
        if y + 1 < height:
            add(x, y + 1)

    mask = Image.new("L", (width, height), 255)
    mask_pixels = mask.load()
    for y in range(height):
        for x in range(width):
            if visited[y * width + x]:
                mask_pixels[x, y] = 0
    mask = mask.filter(ImageFilter.GaussianBlur(0.7))
    if special_mask:
        mask = special_mask(image)
    if keep_polygon:
        from PIL import ImageDraw

        keep = Image.new("L", (width, height), 0)
        ImageDraw.Draw(keep).polygon(keep_polygon, fill=255)
        mask = Image.composite(mask, Image.new("L", mask.size, 0), keep)
    result = image.convert("RGBA")
    result.putalpha(mask)
    bounds = result.getbbox()
    if bounds:
        result = result.crop(bounds)
    result.thumbnail((720, 720), Image.Resampling.LANCZOS)
    result.save(destination)


for filename, source, threshold in SOURCES:
    polygon = None
    special = None
    if filename == "weapon-2-sickle.png":
        def special(image):
            from PIL import ImageDraw

            mask = Image.new("L", image.size, 0)
            draw = ImageDraw.Draw(mask)
            draw.line([(75, 83), (120, 91), (153, 153), (181, 234), (216, 321), (281, 374)], fill=255, width=28)
            draw.ellipse((5, 20, 151, 136), fill=255)
            draw.ellipse((207, 304, 338, 430), fill=255)
            colors = image.load()
            values = mask.load()
            for y in range(image.height):
                for x in range(image.width):
                    if not values[x, y]:
                        continue
                    red, green, blue = colors[x, y]
                    if max(red, green, blue) < 92 or (max(red, green, blue) - min(red, green, blue) < 20 and max(red, green, blue) < 145):
                        values[x, y] = 0
            return mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    remove_edge_background(source, Path(__file__).parent / filename, threshold, polygon, special)
    print(filename)
