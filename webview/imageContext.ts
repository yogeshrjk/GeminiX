/** A bounded local representation; never promises OCR or object recognition. */
export function describeImagePixels(width: number, height: number, pixels: Uint8ClampedArray): string {
  if (width < 1 || width > 32 || height < 1 || height > 24 || pixels.length !== width * height * 4) {
    throw new Error("Invalid sampled image dimensions.");
  }
  const shades = " .:-=+*#%@";
  const rows: string[] = [];
  const colors: string[] = [];
  const tiles: string[] = [];
  for (let y = 0; y < height; y += 1) {
    let row = "";
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r = 0, g = 0, b = 0] = pixels.slice(offset, offset + 3);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      row += shades[Math.min(9, Math.floor(luminance / 256 * 10))] ?? " ";
      if (x % 4 === 0 && y % 4 === 0) {
        colors.push(`${x},${y}:(${r},${g},${b})`);
        tiles.push(`<rect x="${x}" y="${y}" width="4" height="4" fill="rgb(${r},${g},${b})"/>`);
      }
    }
    rows.push(row);
  }
  return [
    "Local raster samples only: coarse layout and color, not OCR or object detection. Original pixels are not sent to Gemini.",
    `Luminance grid (${width}x${height}, dark to light):\n${rows.join("\n")}`,
    `Sampled RGB matrix (x,y:RGB):\n${colors.join(" ")}`,
    `Coarse color mosaic:\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${tiles.join("")}</svg>`
  ].join("\n\n");
}

export async function createLocalImageContext(dataUri: string): Promise<string> {
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUri)) throw new Error("Unsupported image preview.");
  const image = new Image();
  image.src = dataUri;
  await image.decode();
  const width = 32;
  const height = Math.max(1, Math.min(24, Math.round(width * image.naturalHeight / image.naturalWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read the image locally.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return describeImagePixels(width, height, context.getImageData(0, 0, width, height).data);
}
