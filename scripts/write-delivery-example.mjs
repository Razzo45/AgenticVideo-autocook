import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SESSION = "sess_anime_3716eae0";
const CATEGORY = "Anime & Gaming";
const TAGS = ["cyberpunk", "viking", "android", "combat", "anime", "sci-fi", "neon", "rain"];
const STYLE =
  "Cinematic, high-contrast anime style with dynamic lighting from neon sources. Gritty textures, detailed character design, and atmospheric rain effects.";

const shots = [
  {
    media_desc:
      "In a rainy cyberpunk plaza, a Viking warrior faces off against a ceramic android and begins to draw his weapon from his back.",
    image_prompt:
      "Epic wide shot. A burly Viking warrior with a cybernetic eye and braided beard, wearing furs and leather, stands opposite a sleek android made of cracked white ceramic and rust. They face each other in a vast, rain-slicked cyberpunk plaza, dwarfed by towering skyscrapers with glowing neon signs. 16:9 anime style.",
    motion_prompt:
      "Slow dolly zoom towards the Viking. Rain pours down, splashing on the pavement. The Viking exhales a cloud of mist, his eyes locked on the android. He slowly reaches his hand over his shoulder. The sounds of heavy rain, distant city hums, and the creak of leather.",
  },
  {
    media_desc:
      "The Viking's high-tech axe mechanically extends from a collapsed state into its full, glowing form.",
    image_prompt:
      "Extreme close-up on the Viking's hand gripping a complex, collapsed axe head strapped to his back. Mechanical parts are visible. The background is a bokeh of blurred neon lights and rain. The axe begins to glow with a faint blue light.",
    motion_prompt:
      "The camera holds steady. With a series of rapid, satisfying metallic clicks and whirs, the weapon mechanically unfolds and extends into a large, formidable battle-axe with a glowing edge. A few small sparks fly from the mechanism. The Viking pulls the fully formed axe into a two-handed ready stance. Sounds of servos and locking metal.",
  },
  {
    media_desc:
      "The android dashes forward with incredible speed, splashing through the rain-soaked plaza to close the distance to the Viking.",
    image_prompt:
      "Low-angle shot of the android beginning a forward dash. Its ceramic foot kicks up a large splash of water from a puddle. Its body is coiled with potential energy, leaning into the movement. Reflections of neon signs race across its rusted ceramic chassis.",
    motion_prompt:
      "A fast-paced tracking shot follows the android as it closes the distance with inhuman speed and grace. Its movements are fluid, almost silent except for the splashing of its heavy feet in the water and a faint, high-pitched electronic whine from its joints.",
  },
  {
    media_desc:
      "The android's charge is stopped as it presses its hand against the Viking's axe, locking them both in a tense display of strength.",
    image_prompt:
      "Dynamic still frame. The Viking braces, holding his glowing axe horizontally to block. The android's open palm is pressed firmly against the center of the axe's haft. The two are locked in a tense, motionless struggle. A shockwave of water radiates outward from their point of contact. Energy crackles between the axe and the android's hand.",
    motion_prompt:
      "The camera is static but vibrates slightly from the implied force. The rain seems to fall harder. The two figures strain against each other, perfectly still but exuding immense power. The sound of the axe's low energy hum, the straining whine of the android's servos, and the Viking's sharp, heavy breaths.",
  },
  {
    media_desc:
      "The Viking, with a grunt of effort, begins to overpower the android, forcing it back a step in their struggle.",
    image_prompt:
      "Over-the-shoulder shot from behind the Viking, focusing on the android's impassive face. Rainwater trickles down the cracks in its ceramic plating. Its eyes are blank, black lenses. The glowing axe is visible in the lower foreground.",
    motion_prompt:
      "With a powerful grunt, the Viking shoves forward. The camera pushes in slightly as the android is forced back one step, its ceramic foot scraping loudly against the asphalt. The glow from the axe intensifies, casting harsh blue light on the android's face. Sound of a heavy foot dragging and a guttural effort.",
  },
  {
    media_desc:
      "Breaking apart, the Viking and android circle each other warily in the rain, anticipating the next move in their duel.",
    image_prompt:
      "Medium wide shot. The two combatants have broken their deadlock and now stand a few feet apart, circling each other slowly. The Viking holds his glowing axe in a low, defensive stance. The android has its hands raised in a calm, robotic martial arts pose. The city's neon glow reflects in the puddles around their feet.",
    motion_prompt:
      "The camera slowly orbits the two figures, who mirror the movement by circling each other. They are watchful and tense, preparing for the next exchange. The sound of their wet footsteps, the constant downpour, and the ambient noise of the cyberpunk city.",
  },
];

function kfRef(i) {
  return `reference/input_images/${SESSION}_shot${i}_kf.png`;
}
function tailRef(i) {
  return `reference/input_images/${SESSION}_shot${i}_tail.png`;
}
function kfId(i) {
  return `aigc_anime_16eae0_s${i}_kf`;
}
function clipId(i) {
  return `aigc_anime_16eae0_s${i}`;
}

function imageExt() {
  return {
    code_type: null,
    aspect_ratio: "16:9",
    content_safety: "pass",
    source_platform: "Internal Pipeline",
    aesthetic_score: 8.0,
    consistency_score: null,
    visual_style: STYLE,
  };
}

function videoExt() {
  return {
    code_type: "H.264",
    aspect_ratio: "16:9",
    content_safety: "pass",
    source_platform: "Internal Pipeline",
    aesthetic_score: 8.0,
    consistency_score: 90.0,
    visual_style: STYLE,
  };
}

function keyframeRefs(i) {
  if (i === 0) return [];
  const refs = [kfRef(0)];
  if (i > 1) refs.push(kfRef(i - 1));
  refs.push(tailRef(i - 1));
  return refs;
}

const records = [];

for (let i = 0; i < shots.length; i++) {
  const media_id = `${SESSION}_shot${i}_kf.png`;
  records.push({
    uniq_id: kfId(i),
    modality: "image",
    generation_type: "agent_image",
    media_id,
    media_desc: shots[i].media_desc,
    media_path: `image/agent_generated/${media_id}`,
    format: "png",
    width: 2560,
    height: 1440,
    duration: null,
    fps: null,
    resolution: null,
    prompt: shots[i].image_prompt,
    model_name: "bytedance-seed/seedream-4.5",
    category: CATEGORY,
    tags: TAGS,
    session_id: SESSION,
    round_index: null,
    parent_uniq_id: null,
    audio_path: null,
    origin_media_id: null,
    origin_media_path: null,
    mask_path: null,
    reference_images: keyframeRefs(i),
    ext_json: imageExt(),
  });
}

for (let i = 0; i < shots.length; i++) {
  const media_id = `${SESSION}_shot${i}.mp4`;
  records.push({
    uniq_id: clipId(i),
    modality: "video",
    generation_type: "agent_video",
    media_id,
    media_desc: shots[i].media_desc,
    media_path: `video/agent_generated/${media_id}`,
    format: "mp4",
    width: 1920,
    height: 1080,
    duration: 8.0,
    fps: 24,
    resolution: [1920, 1080],
    prompt: shots[i].motion_prompt,
    model_name: "google/veo-3.1",
    category: CATEGORY,
    tags: TAGS,
    session_id: SESSION,
    round_index: 0,
    parent_uniq_id: null,
    audio_path: `audio/generated/${SESSION}_shot${i}.m4a`,
    origin_media_id: null,
    origin_media_path: null,
    mask_path: null,
    reference_images: [kfRef(i)],
    ext_json: videoExt(),
  });
}

records.push({
  uniq_id: "aigc_anime_16eae0_final",
  modality: "video",
  generation_type: "edit_video",
  media_id: `${SESSION}_final.mp4`,
  media_desc:
    "In a rain-soaked, neon-lit cyberpunk city square, a Viking warrior from another time confronts a rusted ceramic android in a tense combat sequence. The Viking wields a high-tech transforming axe against the android's cold, precise movements, creating a clash of ancient fury and future technology.",
  media_path: `video/edited/${SESSION}_final.mp4`,
  format: "mp4",
  width: 1920,
  height: 1080,
  duration: 47.187696,
  fps: 30,
  resolution: [1920, 1080],
  prompt: "Concatenate the six approved storyboard clips into one continuous session cut.",
  model_name: "ffmpeg",
  category: CATEGORY,
  tags: TAGS,
  session_id: SESSION,
  round_index: 1,
  parent_uniq_id: clipId(0),
  audio_path: `audio/generated/${SESSION}_final.m4a`,
  origin_media_id: `${SESSION}_shot0.mp4`,
  origin_media_path: `video/agent_generated/${SESSION}_shot0.mp4`,
  mask_path: null,
  reference_images: [],
  ext_json: {
    ...videoExt(),
    origin_instruction: "Session stitch of approved agent_video shots",
    human_instruction: "Approve stitched session",
    score: 90.0,
  },
});

const out = {
  $schema: "./aigc-meta.schema.json",
  dataset_name: "agentic_poc",
  session_id: SESSION,
  records,
};

const dest = path.join(root, "dataset", "agentic_poc", "meta", `${SESSION}.json`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`wrote ${dest} (${records.length} records)`);
