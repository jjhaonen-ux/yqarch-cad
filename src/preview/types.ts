/** Types for the normalized drawing JSON written by tools/dwg-convert (format "yqweb-drawing@1"). */
export type Pt = [number, number];
export interface EntBase { type: string; layer: string; color?: number; trueColor?: string; linetype?: string; ltScale?: number; lineweight?: number }
export interface TextLike extends EntBase { text: string; p: Pt; p2?: Pt; h: number; rot: number; style: string; halign?: number; valign?: number; widthFactor?: number; oblique?: number; mirrored?: boolean; invisible?: boolean; tag?: string }
export type Entity =
  | (EntBase & { type: 'LINE'; a: Pt; b: Pt })
  | (EntBase & { type: 'POINT'; p: Pt })
  | (EntBase & { type: 'CIRCLE'; c: Pt; r: number })
  | (EntBase & { type: 'ARC'; c: Pt; r: number; a0: number; a1: number })
  | (EntBase & { type: 'ELLIPSE'; c: Pt; major: Pt; ratio: number; a0: number; a1: number })
  | (EntBase & { type: 'LWPOLYLINE'; pts: number[][]; closed: boolean; width?: number })
  | (EntBase & { type: 'SPLINE'; pts: Pt[]; degree: number; closed: boolean })
  | (EntBase & { type: 'SOLID'; pts: Pt[] })
  | (TextLike & { type: 'TEXT' | 'ATTDEF' | 'ATTRIB' })
  | (EntBase & { type: 'MTEXT'; text: string; p: Pt; h: number; rot: number; attach: number; style: string; width?: number })
  | (EntBase & { type: 'INSERT'; name: string; p: Pt; sx: number; sy: number; rot: number; cols?: number; rows?: number; colSpacing?: number; rowSpacing?: number; attribs?: TextLike[] })
  | (EntBase & { type: 'DIMENSION'; block: string })
  | (EntBase & { type: 'HATCH'; pattern: string; solid: boolean; loops: Pt[][]; scale?: number; angle?: number; lines?: { angle: number; base: Pt; offset: Pt; dashes: number[] }[] })
  | (EntBase & { type: 'WIPEOUT'; loop: Pt[] });

export interface LayerJson { name: string; color: number; trueColor?: string; linetype: string; lineweight: number; off: boolean; frozen: boolean; locked: boolean; plot: boolean }
export interface StyleJson { name: string; font: string; bigFont: string; height: number; widthFactor: number; oblique: number }
export interface Drawing {
  format: string; source: string; version: string; units: number; base: Pt; bbox: [number, number, number, number] | null;
  layers: LayerJson[]; styles: StyleJson[]; blocks: Record<string, { base: Pt; entities: Entity[]; anonymous?: boolean }>; entities: Entity[];
}
export interface FontJson { name: string; kind: string; isFont: boolean; above: number; below: number; glyphs: Record<string, { code: number; w: number; p: number[][] }> }
