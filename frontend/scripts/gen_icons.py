"""Generate original app icons: a blue rounded background with a white
speech-bubble mark (matches the login-page logo). Not a trademarked logo."""
from PIL import Image, ImageDraw
from pathlib import Path

BLUE = (24, 119, 242, 255)   # #1877F2
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "public"


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size: int, maskable: bool = False, transparent_bg: bool = False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background
    if not transparent_bg:
        if maskable:
            # full-bleed square (safe-zone handled by OS mask)
            d.rectangle([0, 0, size, size], fill=BLUE)
        else:
            # rounded square
            r = int(size * 0.22)
            rounded_rect(d, [0, 0, size, size], r, BLUE)

    # White speech bubble, centered
    # bubble body
    pad = size * (0.30 if maskable else 0.26)
    bx0, by0 = pad, pad
    bx1, by1 = size - pad, size - pad * 1.15
    br = (by1 - by0) * 0.32
    rounded_rect(d, [bx0, by0, bx1, by1], br, WHITE)

    # tail (bottom-left triangle)
    tail_w = (bx1 - bx0) * 0.22
    tail_x = bx0 + (bx1 - bx0) * 0.20
    tail_top = by1 - br * 0.2
    tail_bottom = by1 + (by1 - by0) * 0.28
    d.polygon(
        [(tail_x, tail_top), (tail_x + tail_w, tail_top), (tail_x + tail_w * 0.15, tail_bottom)],
        fill=WHITE,
    )

    # three dots inside the bubble (chat glyph) in blue
    cy = (by0 + by1) / 2
    dot_r = (bx1 - bx0) * 0.055
    gap = (bx1 - bx0) * 0.20
    cx = (bx0 + bx1) / 2
    for offset in (-gap, 0, gap):
        d.ellipse(
            [cx + offset - dot_r, cy - dot_r, cx + offset + dot_r, cy + dot_r],
            fill=BLUE,
        )
    return img


def save(img, name):
    img.save(OUT / name)
    print("wrote", name, img.size)


if __name__ == "__main__":
    save(make_icon(180), "apple-touch-icon.png")
    save(make_icon(192), "logo192.png")
    save(make_icon(512), "logo512.png")
    save(make_icon(192, maskable=True), "logo192-maskable.png")
    save(make_icon(512, maskable=True), "logo512-maskable.png")
    save(make_icon(512), "logo-original.png")
    save(make_icon(64), "favicon.png")
    print("done")
