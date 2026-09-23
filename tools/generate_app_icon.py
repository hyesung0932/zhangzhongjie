from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIR = ROOT / "native" / "resources"
SIZE = 1024


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def main() -> None:
    RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    panel = Image.new("RGBA", image.size, (0, 0, 0, 0))
    panel_pixels = panel.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = (x + y) / (2 * (SIZE - 1))
            panel_pixels[x, y] = (
                lerp(18, 7, t),
                lerp(34, 16, t),
                lerp(56, 27, t),
                255,
            )

    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((58, 58, 966, 966), radius=236, fill=255)
    image.alpha_composite(Image.composite(panel, Image.new("RGBA", image.size), mask))

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((58, 58, 966, 966), radius=236, outline="#1fbdf5", width=42)
    draw.arc((254, 254, 770, 770), start=45, end=315, fill="#35c6f7", width=134)
    draw.rounded_rectangle((623, 440, 807, 584), radius=42, fill="#08131f", outline="#70e5ff", width=34)

    png_path = RESOURCE_DIR / "app-icon.png"
    ico_path = RESOURCE_DIR / "app-icon.ico"
    image.save(png_path, optimize=True)
    image.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(png_path)
    print(ico_path)


if __name__ == "__main__":
    main()
