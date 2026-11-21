"""Render Payload's parcel mark and Android launcher assets from one geometry."""

from pathlib import Path

from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[1] / "mobile" / "assets"
VIOLET = "#493582"

# The split across the lid reads as a strip of packing tape in negative space.
PARCEL_FACES = (
    (((50, 19), (80, 34), (66, 41), (36, 26)), "#E5D9FF"),
    (((30, 29), (60, 44), (50, 49), (20, 34)), "#E5D9FF"),
    (((20, 39), (48, 53), (48, 81), (20, 67)), "#BDAAF3"),
    (((52, 53), (80, 39), (80, 67), (52, 81)), "#FCF8FF"),
)


def render(name, size, scale, background=None, monochrome=None):
    supersample = 3
    canvas = size * supersample
    image = Image.new("RGBA", (canvas, canvas), background or (0, 0, 0, 0))
    drawing = ImageDraw.Draw(image)

    def to_pixel(coordinate):
        return round(canvas * (0.5 + (coordinate - 50) * scale / 100))

    for face, color in PARCEL_FACES:
        drawing.polygon([(to_pixel(x), to_pixel(y)) for x, y in face], fill=monochrome or color)

    image = image.resize((size, size), Image.Resampling.LANCZOS)
    if background:
        image = image.convert("RGB")
    image.save(ASSETS / name, optimize=True)


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    render("icon.png", 1024, 1.05, background=VIOLET)
    render("adaptive-icon.png", 1024, 0.84)
    render("adaptive-monochrome.png", 1024, 0.84, monochrome="#FFFFFF")
    render("logo.png", 192, 1.43, monochrome=VIOLET)


if __name__ == "__main__":
    main()
