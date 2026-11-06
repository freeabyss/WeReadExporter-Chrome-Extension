#!/usr/bin/env python3
"""生成扩展图标（16/32/48/128）。

运行：
    python3 tools/make-icons.py
依赖：Pillow
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SCALE = 8

TOP_COLOR = (92, 138, 255)
BOTTOM_COLOR = (26, 78, 214)
WHITE = (255, 255, 255, 255)


def build(size: int) -> Image.Image:
    s = size * SCALE
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # 圆角矩形渐变背景
    gradient = Image.new("RGB", (s, s))
    grad_draw = ImageDraw.Draw(gradient)
    for y in range(s):
        t = y / max(s - 1, 1)
        color = tuple(
            int(TOP_COLOR[i] + (BOTTOM_COLOR[i] - TOP_COLOR[i]) * t) for i in range(3)
        )
        grad_draw.line([(0, y), (s, y)], fill=color)

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.225), fill=255)
    canvas.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)

    # 向下箭头
    shaft_w = s * 0.155
    cx = s / 2
    shaft_top = s * 0.17
    shaft_bottom = s * 0.47
    draw.rounded_rectangle(
        [cx - shaft_w / 2, shaft_top, cx + shaft_w / 2, shaft_bottom],
        radius=shaft_w / 2,
        fill=WHITE,
    )

    head_half = s * 0.215
    head_top = s * 0.46
    head_bottom = s * 0.70
    draw.polygon(
        [(cx - head_half, head_top), (cx + head_half, head_top), (cx, head_bottom)],
        fill=WHITE,
    )

    # 底部托盘
    tray_top = s * 0.775
    tray_bottom = s * 0.855
    draw.rounded_rectangle(
        [s * 0.225, tray_top, s * 0.775, tray_bottom],
        radius=s * 0.045,
        fill=WHITE,
    )

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon = build(size)
        path = OUT / f"icon{size}.png"
        icon.save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
