/**
 * PPTX cook — Argon owns slide IR; platform builds minimal OOXML via JSZip.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { PptxPlan } from "../pipeline/schemaDocs";
import { GoogleGenAI } from "@google/genai";
import { withGeminiAdmission } from "../pipeline/geminiAdmission";

type PptxSlide = PptxPlan["slides"][number];

const IMAGE_MODEL = process.env.PRODUCT_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
const EMU_PER_INCH = 914400;

function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "replace-me") throw new Error("GEMINI_API_KEY missing for PPTX image slots");
  return key;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pctBox(slideW: number, slideH: number, x = 5, y = 5, w = 90, h = 20) {
  return {
    x: Math.round((x / 100) * slideW),
    y: Math.round((y / 100) * slideH),
    cx: Math.round((w / 100) * slideW),
    cy: Math.round((h / 100) * slideH),
  };
}

async function genSlotPng(prompt: string, outPath: string, onStatus?: (m: string) => void): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: requireGeminiKey() });
  onStatus?.("Generating slide image slot…");
  await withGeminiAdmission(
    "image",
    async () => {
      const result = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseModalities: ["IMAGE", "TEXT"] },
      });
      for (const c of result.candidates ?? []) {
        for (const part of c.content?.parts ?? []) {
          const data = (part as { inlineData?: { data?: string } }).inlineData;
          if (data?.data) {
            fs.writeFileSync(outPath, Buffer.from(data.data, "base64"));
            return;
          }
        }
      }
      throw new Error("PPTX image slot: no image bytes");
    },
    { onStatus, maxAttempts: 4 },
  );
}

function slideXml(
  slide: PptxSlide,
  slideW: number,
  slideH: number,
  imageRels: Array<{ id: string; rId: string }>,
): string {
  const shapes: string[] = [];
  let shapeId = 2;
  for (const el of slide.elements) {
    const box = pctBox(slideW, slideH, el.x, el.y, el.w, el.h);
    if (el.type === "image_slot") {
      const rel = imageRels.find((r) => r.id === `img_${slide.index}_${shapeId}`);
      if (rel) {
        shapes.push(`
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="${shapeId}" name="Picture ${shapeId}"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="${rel.rId}"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm>
            <a:off x="${box.x}" y="${box.y}"/>
            <a:ext cx="${box.cx}" cy="${box.cy}"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>`);
      }
      shapeId += 1;
      continue;
    }
    const text = escXml(el.text ?? slide.title ?? "");
    const sz = el.type === "title" ? 4400 : 2400;
    const bold = el.type === "title" ? `<a:b/>` : "";
    const fill = el.fill?.replace("#", "") ?? "";
    const solid =
      el.type === "shape" && fill
        ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`
        : `<a:noFill/>`;
    shapes.push(`
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${shapeId}" name="Shape ${shapeId}"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="${box.x}" y="${box.y}"/>
            <a:ext cx="${box.cx}" cy="${box.cy}"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          ${solid}
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="91440" tIns="91440" rIns="91440" bIns="91440"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr algn="l"/>
            <a:r>
              <a:rPr lang="en-US" sz="${sz}" dirty="0">${bold}<a:solidFill><a:srgbClr val="111111"/></a:solidFill>
                <a:latin typeface="Calibri"/>
              </a:rPr>
              <a:t>${text}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>`);
    shapeId += 1;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      ${shapes.join("\n")}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function contentTypes(slideCount: number): string {
  const overrides = Array.from({ length: slideCount }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`;
}

export type GeneratePptxResult = {
  pptxPath: string;
  imagePaths: string[];
};

export async function generatePptx(opts: {
  plan: PptxPlan;
  outDir: string;
  onStatus?: (msg: string) => void;
}): Promise<GeneratePptxResult> {
  const slideW = Math.round((opts.plan.width_in ?? 13.333) * EMU_PER_INCH);
  const slideH = Math.round((opts.plan.height_in ?? 7.5) * EMU_PER_INCH);
  const mediaDir = path.join(opts.outDir, "pptx_media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    contentTypes(opts.plan.slides.length),
  );
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
  );

  const ppt = zip.folder("ppt")!;
  const slidesFolder = ppt.folder("slides")!;
  const slideRelsFolder = slidesFolder.folder("_rels")!;
  const mediaFolder = ppt.folder("media")!;
  const imagePaths: string[] = [];

  const sldIdLst = opts.plan.slides
    .map((s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join("");

  ppt.file(
    "presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 saveSubsetFonts="1">
  <p:sldMasterIdLst/>
  <p:sldIdLst>${sldIdLst}</p:sldIdLst>
  <p:sldSz cx="${slideW}" cy="${slideH}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );

  const presRels = opts.plan.slides
    .map((s, i) =>
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("");
  ppt.folder("_rels")!.file(
    "presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${presRels}
</Relationships>`,
  );

  let mediaIndex = 0;
  for (let i = 0; i < opts.plan.slides.length; i++) {
    const slide = opts.plan.slides[i]!;
    opts.onStatus?.(`Building slide ${i + 1}/${opts.plan.slides.length}…`);
    const imageRels: Array<{ id: string; rId: string; file: string }> = [];
    let shapeId = 2;
    const relParts: string[] = [];

    for (const el of slide.elements) {
      if (el.type !== "image_slot") {
        shapeId += 1;
        continue;
      }
      mediaIndex += 1;
      const fileName = `image${mediaIndex}.png`;
      const abs = path.join(mediaDir, fileName);
      const prebuilt = el.image_file?.trim();
      if (prebuilt && fs.existsSync(prebuilt)) {
        opts.onStatus?.(`Embedding Argon-tool image ${path.basename(prebuilt)}…`);
        fs.copyFileSync(prebuilt, abs);
      } else {
        const prompt = el.image_prompt?.trim() || el.text?.trim() || "Abstract brand visual";
        await genSlotPng(prompt, abs, opts.onStatus);
      }
      imagePaths.push(abs);
      const buf = fs.readFileSync(abs);
      mediaFolder.file(fileName, buf);
      const rId = `rId${imageRels.length + 1}`;
      const id = `img_${slide.index}_${shapeId}`;
      imageRels.push({ id, rId, file: fileName });
      relParts.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${fileName}"/>`,
      );
      shapeId += 1;
    }

    slidesFolder.file(
      `slide${i + 1}.xml`,
      slideXml(
        slide,
        slideW,
        slideH,
        imageRels.map((r) => ({ id: r.id, rId: r.rId })),
      ),
    );
    slideRelsFolder.file(
      `slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relParts.join("\n")}
</Relationships>`,
    );
  }

  const pptxPath = path.join(opts.outDir, "master.pptx");
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(pptxPath, buf);
  fs.writeFileSync(path.join(opts.outDir, "pptx_plan.json"), JSON.stringify(opts.plan, null, 2));
  return { pptxPath, imagePaths };
}
