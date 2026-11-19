// Draws one SVG to PNG in its own process, so it sees the fonts fetched for this file.
// The worker's own fontconfig is read once at startup and never sees a later font.
// argv[2]: JSON { input, output, density, width?, height? }
const sharp = require("sharp");
const job = JSON.parse(process.argv[2]);
let img = sharp(job.input, { density: job.density, limitInputPixels: false });
if (job.width && job.height) img = img.resize(Math.round(job.width), Math.round(job.height), { fit: "fill" });
img
  .png()
  .toFile(job.output)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
