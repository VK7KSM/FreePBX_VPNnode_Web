from pathlib import Path
import argparse
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
res = Path(__file__).resolve().parents[1] / 'app/src/main/res'
logo = Image.open(args.source).convert('RGBA')
for density, scale in [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]:
    for name, canvas_dp, width_dp in [('ic_gateway', 48, 48), ('ic_gateway_foreground', 108, 68)]:
        size = round(canvas_dp * scale)
        width = round(width_dp * scale)
        mark = logo.resize((width, round(width * logo.height / logo.width)), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
        target = res / ('mipmap-' + density)
        target.mkdir(parents=True, exist_ok=True)
        canvas.save(target / (name + '.png'))
