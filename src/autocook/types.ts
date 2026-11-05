import type { ScriptPlan, AudioPlan } from "../pipeline/schema";
import type { HtmlPlan, ImagePlan, PptxPlan, PdfPlan, CookKind, DocumentPlan } from "../pipeline/schemaDocs";
import type { VideoAspect, OutputResolution, Category } from "../pipeline/constants";

export type AutocookMode = CookKind;

export type PlanCookInput = {
  prompt: string;
  mode?: AutocookMode;
  /** Target duration in seconds (video/audio). */
  durationSec?: number;
  aspect?: VideoAspect;
  category?: Category;
  /** Optional attachment text (scripts, briefs) for the brain. */
  attachmentText?: string;
  attachmentNames?: string[];
  /** Work dir for Argon media tools (image/video staging during HTML/PPTX plan). */
  workDir?: string;
  referenceImagePaths?: string[];
  onStatus?: (msg: string) => void;
};

export type PlanCookResult =
  | { mode: "video"; plan: ScriptPlan; brainModel: string }
  | { mode: "audio"; plan: AudioPlan; brainModel: string }
  | { mode: "html"; plan: HtmlPlan; brainModel: string }
  | { mode: "image"; plan: ImagePlan; brainModel: string }
  | { mode: "pptx"; plan: PptxPlan; brainModel: string }
  | { mode: "pdf"; plan: PdfPlan; brainModel: string };

export type GenerateSegmentInput = {
  shotIndex: number;
  plan: ScriptPlan;
  aspect: VideoAspect;
  outputResolution?: OutputResolution;
  /** Absolute path for the keyframe still. */
  keyframeOutPath: string;
  /** Absolute path for the clip mp4. */
  clipOutPath: string;
  keyframeModel?: string;
  videoModel?: string;
  /** Previous clip path when transition is continue. */
  previousClipPath?: string;
  onStatus?: (msg: string) => void;
};

export type GenerateSegmentResult = {
  shotIndex: number;
  keyframePath: string;
  clipPath: string;
  transition: "cut" | "continue";
};

export type AssembleInput = {
  clipPaths: string[];
  outPath: string;
  aspect?: VideoAspect;
  outputResolution?: OutputResolution;
  targetDurationSec?: number;
  onStatus?: (msg: string) => void;
};

export type AssembleResult = {
  masterPath: string;
  durationSec: number | null;
};

export type RunAutocookInput = PlanCookInput & {
  workDir: string;
  keyframeModel?: string;
  videoModel?: string;
  outputResolution?: OutputResolution;
  onStatus?: (msg: string) => void;
  /** Reference image paths for PNG generation (operator plates). */
  referenceImagePaths?: string[];
};

export type RunAutocookResult = {
  mode: AutocookMode;
  plan: ScriptPlan | AudioPlan | DocumentPlan;
  masterPath?: string;
  /** Extra deliverable paths (e.g. pdf beside html, dual wav). */
  deliverablePaths?: string[];
  segmentPaths?: string[];
  brainModel: string;
};
