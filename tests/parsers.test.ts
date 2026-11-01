import { describe, expect, it } from 'vitest';
import { splitSmart, stripComment } from '../src/parsers/csv.js';
import { parseShortcutYqs, buildCommandCatalog, aliasOverrides, parsePanels } from '../src/parsers/commands.js';
import { parseConfig } from '../src/parsers/config.js';
import { parseLayers, parseHatchKeys, parseNumberRows } from '../src/parsers/profile.js';
import { parsePat } from '../src/parsers/pat.js';
import { parseLin } from '../src/parsers/lin.js';
import { aciToHex } from '../src/util/aci.js';
import { bulgePoints } from '../src/util/geom.js';
import { decodeText, gbkCodeToChar } from '../src/util/encoding.js';

describe('csv helpers', () => {
  it('splits respecting parentheses and quotes', () => {
    expect(splitSmart('a,(b,c),"d,e" ,f')).toEqual(['a', '(b,c)', '"d,e"', 'f']);
  });
  it('strips trailing comments outside expressions', () => {
    expect(stripComment('X = (a ";" b) ; note')).toEqual(['X = (a ";" b)', 'note']);
  });
});

const YQS = [
  ';;; header comment',
  '****【系统设定】 命令列表,[System Setup] Command List,yq_systemsetup,sys,sys',
  '源泉总览命令,YQArch Command Pandect,yqarch,yq,yq',
  '--',
  '用户系统配置,User Preferences,yq_sys_setting,yqsys,yqsys',
  '****【立面】 命令列表,[Elevation] Command List,yq_elev,el,el',
  '玻璃隔断剖面,Section of Partition",yq_glass_partition,mqs,mqs',
].join('\n');

describe('commands', () => {
  it('parses categories, groups and commands (tolerating stray quotes)', () => {
    const { categories, commands } = parseShortcutYqs(YQS);
    expect(categories.map((c) => c.id)).toEqual(['systemsetup', 'elev']);
    expect(categories[0]).toMatchObject({ zh: '系统设定', en: 'System Setup', panelAlias: 'sys' });
    expect(commands).toHaveLength(3);
    expect(commands[1]).toMatchObject({ id: 'yq_sys_setting', group: 1, alias: 'yqsys', category: 'systemsetup' });
    expect(commands[2]).toMatchObject({ id: 'yq_glass_partition', en: 'Section of Partition', category: 'elev' });
  });
  it('computes per-profile alias overrides', () => {
    const custom = YQS.replace('yqarch,yq,yq', 'yqarch,yq,yy');
    expect(aliasOverrides(YQS, custom)).toEqual({ yqarch: 'yy' });
  });
  it('builds a catalog even without a reference file', () => {
    const cat = buildCommandCatalog(YQS, null);
    expect(cat.commands.every((c) => c.description === null && c.stars === null)).toBe(true);
  });
  it('parses panels', () => {
    const panels = parsePanels(['******[建筑],[Arch],12,ar', '****墙体,Wall ;hint', '画墙,Wall,yq_wall,w', ',,,'].join('\n'));
    expect(panels[0]).toMatchObject({ zh: '建筑', en: 'Arch', buttonsPerColumn: 12, alias: 'ar' });
    expect(panels[0].sections[0]).toMatchObject({ zh: '墙体', en: 'Wall', hint: 'hint' });
    expect(panels[0].sections[0].items.map((i) => i.separator)).toEqual([false, true]);
  });
});

describe('profile files', () => {
  it('parses config.txt with labels and typed values', () => {
    const cfg = parseConfig([
      'LANGUAGE                 = 0          ;【当前语言】0:English 1:中文',
      'YQARCH_MENU              = yes        ;【是否显示源泉菜单栏】',
      'DRAWING_SCALE_LIST       = 1,2,5,10',
      '                                      ;【常用图纸比例】',
      'AXIS_LAYER_NAME          = DOTE       ;【轴线层名】',
    ].join('\n'));
    expect(cfg.values.LANGUAGE).toBe(0);
    expect(cfg.values.YQARCH_MENU).toBe(true);
    expect(cfg.values.DRAWING_SCALE_LIST).toEqual([1, 2, 5, 10]);
    expect(cfg.values.AXIS_LAYER_NAME).toBe('DOTE');
    expect(cfg.entries[0].label).toBe('当前语言');
  });
  it('parses layers and hatch keys', () => {
    expect(parseLayers('WALL,1,Continuous,0.3,yes,墙体')[0]).toEqual({ name: 'WALL', color: 1, linetype: 'Continuous', lineweight: 0.3, plot: true, description: '墙体' });
    expect(parseHatchKeys('hnt,钢筋混凝土,10,0,no,no')[0]).toMatchObject({ alias: 'hnt', pattern: '钢筋混凝土', scale: 10, angle: 0, extra: ['no', 'no'] });
  });
  it('expands number rows like 3*600', () => {
    expect(parseNumberRows('3*600 1200')[0].values).toEqual([600, 600, 600, 1200]);
  });
});

describe('hatch patterns and linetypes', () => {
  it('parses .pat definitions with dashes', () => {
    const { patterns } = parsePat('*ANSI31, ANSI Iron\n45, 0,0, 0,3.175\n*DASH, test\n0, 0,0, 0,3, 2,-1\n');
    expect(patterns.map((p) => p.name)).toEqual(['ANSI31', 'DASH']);
    expect(patterns[1].lines[0]).toEqual({ angle: 0, origin: [0, 0], delta: [0, 3], dashes: [2, -1] });
  });
  it('parses complex linetypes including continuation lines', () => {
    const { linetypes, warnings } = parseLin([
      '*GAS,Gas ---- GAS ----',
      'A,12.7,-5.08,["GAS",STANDARD,S=2.54,R=0.0,X=-2.54,Y=-1.27],-6.35',
      '*TRACK,Track',
      'A,.5,[TRACK1,ltypeshp.shx,s=.25],',
      '-.5',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(linetypes[0].elements[2]).toMatchObject({ kind: 'text', text: 'GAS', style: 'STANDARD' });
    expect(linetypes[1].elements.map((e) => e.kind)).toEqual(['dash', 'shape', 'dash']);
  });
});

describe('utilities', () => {
  it('maps the standard ACI colors', () => {
    expect(aciToHex(1)).toBe('#ff0000');
    expect(aciToHex(5)).toBe('#0000ff');
    expect(aciToHex(7)).toBe('#ffffff');
  });
  it('generates bulge arcs (bulge 1 = semicircle)', () => {
    const pts = bulgePoints([0, 0], [2, 0], 1, 64);
    const mid = pts[Math.floor(pts.length / 2)];
    expect(Math.hypot(mid[0] - 1, mid[1])).toBeCloseTo(1, 3);
    expect(mid[1]).toBeLessThan(0); // positive bulge = counter-clockwise, so the arc bulges to the right of p0->p1
  });
  it('decodes GBK text and big-font codes', () => {
    const gbk = new Uint8Array([0xd4, 0xb4, 0xc8, 0xaa]); // 源泉
    expect(decodeText(gbk).text).toBe('源泉');
    expect(gbkCodeToChar(0xd4b4)).toBe('源');
  });
});
