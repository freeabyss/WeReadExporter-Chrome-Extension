#!/usr/bin/env python3
"""生成 Chrome 网上应用店商店素材。

运行：
    python3 tools/make-store-assets.py

产物（store/）：
    icon128.png                 128x128   商店图标（必需）
    small-promo-440x280.png     440x280   小型宣传图（必需）
    screenshot-1-1280x800.png   1280x800  截图 1
    screenshot-2-1280x800.png   1280x800  截图 2
    marquee-1400x560.png        1400x560  横幅宣传图（可选，用于精选展示）

依赖：Pillow；使用 docs/panel.png（真实 Chrome 截图，由
`WRX_SCREENSHOT=docs/panel.png npm run test:chrome` 生成）。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store"
PANEL = ROOT / "docs" / "panel.png"
ICON = ROOT / "icons" / "icon128.png"

FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_LIGHT_PATH = "/System/Library/Fonts/STHeiti Light.ttc"

BG_TOP = (238, 244, 255)
BG_BOTTOM = (214, 228, 255)
PRIMARY = (47, 107, 255)
INK = (24, 34, 56)
MUTED = (92, 108, 132)
WHITE = (255, 255, 255)


def font(size, light=False):
    return ImageFont.truetype(FONT_LIGHT_PATH if light else FONT_PATH, size, index=0)


def gradient(size, top=BG_TOP, bottom=BG_BOTTOM):
    w, h = size
    image = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(image)
    for y in range(h):
        t = y / max(h - 1, 1)
        draw.line(
            [(0, y), (w, y)],
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return image


def add_decor(image):
    """右上角淡淡的光晕圆，避免大面积纯色。"""
    w, h = image.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([w * 0.55, -h * 0.45, w * 1.35, h * 0.55], fill=(255, 255, 255, 90))
    d.ellipse([w * 0.72, h * 0.45, w * 1.3, h * 1.35], fill=(47, 107, 255, 26))
    layer = layer.filter(ImageFilter.GaussianBlur(60))
    return Image.alpha_composite(image.convert("RGBA"), layer)


def rounded(image, radius):
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, image.width - 1, image.height - 1], radius=radius, fill=255
    )
    result = image.convert("RGBA")
    result.putalpha(mask)
    return result


def panel_crop():
    """从真实截图中裁出悬浮面板区域。"""
    source = Image.open(PANEL).convert("RGB")
    # 面板位于截图右侧（原图 2560x1800），按显示比例裁切。
    w, h = source.size
    box = (
        int(w * 0.705),
        int(h * 0.115),
        int(w * 0.985),
        int(h * 0.925),
    )
    return source.crop(box)


def draw_bullets(draw, x, y, items, size=22, gap=38, color=MUTED):
    f = font(size, light=True)
    for item in items:
        draw.ellipse([x, y + 9, x + 9, y + 18], fill=PRIMARY)
        draw.text((x + 22, y), item, font=f, fill=color)
        y += gap
    return y


def make_screenshot(number, crop_box, out_name):
    W, H = 1280, 800
    image = add_decor(gradient((W, H)))

    # 左侧文案
    d = ImageDraw.Draw(image)
    d.rounded_rectangle([70, 62, 246, 102], radius=20, fill=(226, 236, 255))
    d.text((88, 70), "Chrome 扩展", font=font(20), fill=PRIMARY)

    d.text((68, 140), "微信读书导出助手", font=font(58), fill=INK)
    d.text((70, 220), "一键导出章节与整本书全文", font=font(30, light=True), fill=MUTED)

    if number == 1:
        bullets = [
            "Markdown / HTML / TXT 三种格式",
            "逐章抓取 · 进度显示 · 可随时取消",
            "失败自动重试，残缺内容明确告警",
        ]
    else:
        bullets = [
            "章节列表：跳转、单章复制与下载",
            "每章状态一目了然（成功 / 告警 / 失败）",
            "结果卡片可再次下载或复制全文",
        ]
    draw_bullets(d, 72, 300, bullets)

    d.text((70, 470), "本地运行 · 无后台 · 不收集数据", font=font(22, light=True), fill=MUTED)

    # 右侧面板截图
    shot = panel_crop().crop(crop_box) if crop_box else panel_crop()
    max_h = 690
    scale = max_h / shot.height
    shot = shot.resize((int(shot.width * scale), max_h), Image.LANCZOS)
    if shot.width > 520:
        scale = 520 / shot.width
        shot = shot.resize((520, int(shot.height * scale)), Image.LANCZOS)

    card = rounded(shot, 18)
    shadow = Image.new("RGBA", (card.width + 60, card.height + 60), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle([30, 30, 30 + card.width, 30 + card.height], radius=18, fill=(30, 50, 90, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))

    px = W - card.width - 60
    py = (H - card.height) // 2
    image = image.convert("RGBA")
    image.alpha_composite(shadow, (px - 30, py - 30))
    image.alpha_composite(card, (px, py))

    path = OUT / out_name
    image.convert("RGB").save(path, "PNG", optimize=True)
    print("wrote", path.relative_to(ROOT))


def make_marquee():
    W, H = 1400, 560
    image = add_decor(gradient((W, H)))
    d = ImageDraw.Draw(image)

    icon = Image.open(ICON).convert("RGBA").resize((180, 180), Image.LANCZOS)
    image.alpha_composite(icon, (70, 70))

    d.text((290, 96), "微信读书导出助手", font=font(64), fill=INK)
    d.text((294, 186), "一键导出章节与整本书全文", font=font(32, light=True), fill=MUTED)

    chips = ["Markdown", "HTML", "TXT", "全文导出"]
    x = 294
    for chip in chips:
        w = int(d.textlength(chip, font=font(24))) + 40
        d.rounded_rectangle([x, 262, x + w, 310], radius=24, fill=(255, 255, 255, 235))
        d.text((x + 20, 268), chip, font=font(24), fill=PRIMARY)
        x += w + 14

    d.text((294, 370), "仅供导出你有权阅读的内容 · 不收集任何数据", font=font(24, light=True), fill=MUTED)
    d.rounded_rectangle([70, 400, 246, 452], radius=26, fill=PRIMARY)
    d.text((96, 410), "免费开源", font=font(24), fill=WHITE)

    # 右侧放一小块真实界面
    shot = panel_crop()
    crop = shot.crop((0, 0, shot.width, int(shot.height * 0.52)))
    crop = crop.resize((int(crop.width * 0.56), int(crop.height * 0.56)), Image.LANCZOS)
    card = rounded(crop, 16)
    image = image.convert("RGBA")
    image.alpha_composite(card, (W - card.width - 70, 40))

    path = OUT / "marquee-1400x560.png"
    image.convert("RGB").save(path, "PNG", optimize=True)
    print("wrote", path.relative_to(ROOT))


def make_small_promo():
    W, H = 440, 280
    image = add_decor(gradient((W, H)))
    d = ImageDraw.Draw(image)

    icon = Image.open(ICON).convert("RGBA").resize((92, 92), Image.LANCZOS)
    image.alpha_composite(icon, (30, 30))

    d.text((30, 140), "微信读书导出助手", font=font(34), fill=INK)
    d.text((31, 190), "章节与全文 · Markdown / HTML / TXT", font=font(19, light=True), fill=MUTED)
    d.rounded_rectangle([30, 232, 156, 260], radius=14, fill=PRIMARY)
    d.text((46, 236), "一键导出", font=font(17), fill=WHITE)

    path = OUT / "small-promo-440x280.png"
    image.convert("RGB").save(path, "PNG", optimize=True)
    print("wrote", path.relative_to(ROOT))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if not PANEL.exists():
        raise SystemExit("缺少 docs/panel.png，请先运行：WRX_SCREENSHOT=docs/panel.png npm run test:chrome")

    # 截图 1：完整面板；截图 2：面板下半部分（章节列表 / 结果卡片）
    make_screenshot(1, None, "screenshot-1-1280x800.png")
    make_screenshot(2, (0, int(panel_crop().height * 0.30), panel_crop().width, panel_crop().height),
                    "screenshot-2-1280x800.png")
    make_small_promo()
    make_marquee()

    import shutil
    shutil.copyfile(ICON, OUT / "icon128.png")
    print("wrote", (OUT / "icon128.png").relative_to(ROOT))


if __name__ == "__main__":
    main()
