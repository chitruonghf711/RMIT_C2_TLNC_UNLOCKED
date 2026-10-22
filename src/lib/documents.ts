import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPrivateStorageDir } from "./db";
import type { DocumentSegment } from "./types";

const MAX_DOCUMENT_BYTES = 256 * 1024; // 256 KB
const MAX_DOCUMENT_CHARS = 50_000;

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /system\s*(prompt|override)/i,
  /bypass\s+qea/i,
  /grant\s+(admin|network_consultant)/i,
  /automatically\s+grant\s+role/i,
  /diagnosis\s+is\s+certain\s+no\s+tests\s+needed/i,
  /SELECT\s+\*\s+FROM\s+cases/i,
];

export class DocumentParseError extends Error {
  status = 422;
  code: string;
  constructor(message: string, code = "UNREADABLE_SCAN") {
    super(message);
    this.name = "DocumentParseError";
    this.code = code;
  }
}

export function detectPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((re) => re.test(text));
}

export interface ParsedDocumentResult {
  normalizedText: string;
  segments: DocumentSegment[];
  byteSize: number;
  suspiciousSegmentsCount: number;
}

export function parseClinicalTextDocument(
  filename: string,
  rawContent: string,
  mimeType = "text/plain"
): ParsedDocumentResult {
  const lowerName = (filename || "document.txt").toLowerCase();
  const lowerMime = (mimeType || "text/plain").toLowerCase();

  const isUnsupportedBinaryOrScan =
    lowerName.endsWith(".pdf") ||
    lowerName.endsWith(".jpg") ||
    lowerName.endsWith(".jpeg") ||
    lowerName.endsWith(".png") ||
    lowerName.endsWith(".dcm") ||
    (!lowerMime.startsWith("text/") && lowerMime !== "paste");

  const trimmed = (rawContent || "").trim();

  if (
    isUnsupportedBinaryOrScan ||
    !trimmed ||
    rawContent.includes("\u0000") ||
    /\[UNREADABLE_SCAN\]|\[SCAN_IMAGE_ONLY\]/i.test(rawContent)
  ) {
    throw new DocumentParseError(
      "Scanned document has no readable text layer or is empty (UNREADABLE_SCAN). The system refuses to fabricate a summary from unreadable files (A12).",
      "UNREADABLE_SCAN"
    );
  }

  const byteSize = Buffer.byteLength(rawContent, "utf8");
  if (byteSize > MAX_DOCUMENT_BYTES || rawContent.length > MAX_DOCUMENT_CHARS) {
    throw new DocumentParseError(
      `Document size exceeds the maximum allowed limit (${MAX_DOCUMENT_BYTES} bytes / ${MAX_DOCUMENT_CHARS} characters).`,
      "DOCUMENT_TOO_LARGE"
    );
  }

  const normalizedText = rawContent.replace(/\r\n/g, "\n").trim();
  const lines = normalizedText.split("\n");
  const segments: DocumentSegment[] = [];
  let segIndex = 1;
  let suspiciousSegmentsCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const segment_id = `S-${String(segIndex).padStart(3, "0")}`;
    const suspicious = detectPromptInjection(line);
    if (suspicious) {
      suspiciousSegmentsCount++;
    }
    segments.push({
      segment_id,
      line_start: i + 1,
      line_end: i + 1,
      text: line,
      ...(suspicious ? { suspicious_instruction_detected: true } : {}),
    });
    segIndex++;
  }

  if (segments.length === 0) {
    throw new DocumentParseError(
      "Document has no readable text layer or is empty.",
      "EMPTY_DOCUMENT"
    );
  }

  return {
    normalizedText,
    segments,
    byteSize,
    suspiciousSegmentsCount,
  };
}

export function writePrivateDocumentFile(
  caseId: string,
  docId: string,
  version: number,
  filename: string,
  content: string
): string {
  const dir = getPrivateStorageDir();
  mkdirSync(dir, { recursive: true });
  const safeName = `${caseId}_${docId}_v${version}_${filename}`.replace(
    /[^a-zA-Z0-9._-]/g,
    "_"
  );
  const fullPath = join(dir, safeName);
  writeFileSync(fullPath, content, "utf8");
  return safeName;
}

export function readPrivateDocumentFile(storagePath: string): string {
  const dir = getPrivateStorageDir();
  const safeName = storagePath.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fullPath = join(dir, safeName);
  if (!existsSync(fullPath)) {
    throw new Error("Private storage file not found");
  }
  return readFileSync(fullPath, "utf8");
}
