/** Drawing-wide settings persisted with the document. Paper sizes (text, arrows) are in millimetres on paper. */
export interface DimStyle {
  /** Text height on paper (mm). */ textHeight: number;
  /** Arrow / tick size on paper (mm). */ arrowSize: number;
  arrow: 'tick' | 'arrow' | 'dot';
  /** Gap between object and extension line (paper mm). */ extOffset: number;
  /** Extension beyond the dimension line (paper mm). */ extBeyond: number;
  /** Gap between dimension line and text (paper mm). */ textGap: number;
  /** Decimal places of the measured value. */ precision: number;
  textStyle: string;
}
export interface DocSettings {
  /** Annotation scale denominator: 100 means 1:100. */ drawingScale: number;
  /** Global linetype scale (LTSCALE). */ ltscale: number;
  /** Default text height on paper (mm). */ textHeight: number;
  dim: DimStyle;
  currentLayer: string;
  /** 256 = ByLayer, 0 = ByBlock. */ currentColor: number;
  currentLinetype: string;
  currentLtScale: number;
  currentTextStyle: string;
  hatchPattern: string; hatchScale: number; /** degrees */ hatchAngle: number;
  /** Coordinate / length display precision. */ precision: number;
  /** Profile (YQArch user folder) the drawing was created with. */ profile: string;
  /** MIRRTEXT: false/absent = mirrored texts stay readable (AutoCAD default 0), true = texts are mirrored exactly. */ mirrText?: boolean;
}
export const UNIT_NAMES: Record<number, string> = { 0: 'unitless', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
/** Drawing units per paper millimetre. */
export function unitsPerMm(units: number): number {
  switch (units) { case 1: return 1 / 25.4; case 2: return 1 / 304.8; case 5: return 0.1; case 6: return 0.001; default: return 1; }
}
/** Factor converting a length in `from` units to `to` units (INSUNITS codes). */
export function unitConversion(from: number, to: number): number {
  if (!from || !to || from === to) return 1;
  return unitsPerMm(to) / unitsPerMm(from);
}
export function defaultSettings(): DocSettings {
  return {
    drawingScale: 100, ltscale: 100, textHeight: 3.5,
    dim: { textHeight: 2.5, arrowSize: 1.5, arrow: 'tick', extOffset: 1, extBeyond: 1.5, textGap: 0.8, precision: 0, textStyle: 'Standard' },
    currentLayer: '0', currentColor: 256, currentLinetype: 'ByLayer', currentLtScale: 1, currentTextStyle: 'Standard',
    hatchPattern: 'ANSI31', hatchScale: 1, hatchAngle: 0, precision: 2, profile: 'user1',
  };
}
