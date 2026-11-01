/**
 * Core entity model of the Phase 2 engine.
 * The shape intentionally matches the `yqweb-drawing@1` format produced in Phase 1 (see docs/asset-formats.md),
 * so converted YQArch blocks load without translation and saved drawings stay readable by the preview tool.
 * Runtime entities carry a numeric `id` (not persisted); entities inside block definitions use id -1.
 */
export type Pt = [number, number];

export interface EntBase {
  id: number;
  type: string;
  layer: string;
  /** ACI color: absent/256 = ByLayer, 0 = ByBlock, 1..255 = index. */
  color?: number;
  trueColor?: string;
  /** Linetype name: absent = ByLayer, 'BYBLOCK', 'CONTINUOUS', ... */
  linetype?: string;
  ltScale?: number;
  /** 1/100 mm; -1 ByLayer, -2 ByBlock, -3 Default. */
  lineweight?: number;
}

export interface TextProps {
  text: string; p: Pt; p2?: Pt; h: number; rot: number; style: string;
  halign?: number; valign?: number; widthFactor?: number; oblique?: number; mirrored?: boolean; invisible?: boolean; tag?: string; prompt?: string;
}

export type LineEnt = EntBase & { type: 'LINE'; a: Pt; b: Pt };
export type PointEnt = EntBase & { type: 'POINT'; p: Pt };
export type CircleEnt = EntBase & { type: 'CIRCLE'; c: Pt; r: number };
export type ArcEnt = EntBase & { type: 'ARC'; c: Pt; r: number; a0: number; a1: number };
export type EllipseEnt = EntBase & { type: 'ELLIPSE'; c: Pt; major: Pt; ratio: number; a0: number; a1: number };
/** pts: [x, y, bulge?] — bulge applies to the segment that starts at this vertex. */
export type PolylineEnt = EntBase & { type: 'LWPOLYLINE'; pts: number[][]; closed: boolean; width?: number; source?: string };
export type SplineEnt = EntBase & { type: 'SPLINE'; pts: Pt[]; degree: number; closed: boolean; knots?: number[]; ctrl?: number[][]; weights?: number[]; fit?: number[][] };
export type SolidEnt = EntBase & { type: 'SOLID'; pts: Pt[] };
export type TextEnt = EntBase & TextProps & { type: 'TEXT' | 'ATTDEF' | 'ATTRIB' };
export type MTextEnt = EntBase & { type: 'MTEXT'; text: string; p: Pt; h: number; rot: number; attach: number; style: string; width?: number; lineSpacing?: number };
export type InsertEnt = EntBase & {
  type: 'INSERT'; name: string; p: Pt; sx: number; sy: number; rot: number;
  cols?: number; rows?: number; colSpacing?: number; rowSpacing?: number; attribs?: (TextProps & Partial<EntBase>)[];
};
/**
 * DIMENSION. Converted drawings reference a pre-drawn anonymous block (`block`).
 * Dimensions created by the engine are associative-by-definition: `kind` + defining points, geometry generated at render time.
 */
export type DimKind = 'linear' | 'aligned' | 'radius' | 'diameter';
export type DimEnt = EntBase & {
  type: 'DIMENSION';
  block?: string; dimType?: number | string; measurement?: number; textPoint?: Pt; style?: string;
  kind?: DimKind;
  /** linear/aligned: extension line origins. radius/diameter: p1 = center, p2 = point on circle. */
  p1?: Pt; p2?: Pt;
  /** Point the dimension line passes through (linear/aligned). */
  loc?: Pt;
  /** Dimension line angle for `linear` (radians). */
  rot?: number;
  /** Text override; '<>' is replaced by the measured value. */
  text?: string;
  /** Dimension scale snapshot (drawing scale at creation). */
  dimScale?: number;
  /** Affine transform applied to the pre-drawn `block` geometry (set when a converted dimension is moved/rotated). */
  xform?: [number, number, number, number, number, number];
};
export type HatchLine = { angle: number; base: Pt; offset: Pt; dashes: number[] };
/** `angle` is in degrees; `origin` is the pattern origin used when `lines` are generated from the named pattern. */
export type HatchEnt = EntBase & { type: 'HATCH'; pattern: string; solid: boolean; loops: Pt[][]; scale?: number; angle?: number; origin?: Pt; lines?: HatchLine[]; style?: number };
export type WipeoutEnt = EntBase & { type: 'WIPEOUT'; loop: Pt[] };

export type Entity =
  | LineEnt | PointEnt | CircleEnt | ArcEnt | EllipseEnt | PolylineEnt | SplineEnt | SolidEnt
  | TextEnt | MTextEnt | InsertEnt | DimEnt | HatchEnt | WipeoutEnt;
export type EntityType = Entity['type'];

/** Distributive Omit that keeps the union discriminated. */
export type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An entity before it is added to a document. */
export type NewEntity = DistOmit<Entity, 'id'> & { id?: number };

export interface Layer {
  name: string; color: number; trueColor?: string; linetype: string; lineweight: number;
  off: boolean; frozen: boolean; locked: boolean; plot: boolean; description?: string;
}
export interface LinetypeDef { name: string; description?: string; length?: number; pattern: number[] }
export interface TextStyle { name: string; font: string; bigFont: string; height: number; widthFactor: number; oblique: number }
export interface BlockDef { name: string; base: Pt; entities: Entity[]; anonymous?: boolean; units?: number; source?: string }

export type BBox = [number, number, number, number];
export const emptyBox = (): BBox => [Infinity, Infinity, -Infinity, -Infinity];
export const boxValid = (b: BBox) => b[0] <= b[2] && b[1] <= b[3];
export function boxAdd(b: BBox, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
}
export function boxUnion(a: BBox, b: BBox): BBox { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }
export const boxIntersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const boxInside = (inner: BBox, outer: BBox) => inner[0] >= outer[0] && inner[2] <= outer[2] && inner[1] >= outer[1] && inner[3] <= outer[3];
