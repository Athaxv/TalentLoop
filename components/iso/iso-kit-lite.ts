// Runtime subset of the anatomy iso kit — camera and path helpers copied
// verbatim from the kit (C:\Users\Atharv\.claude\skills\anatomy\kit\iso-kit.mjs)
// so the live footer figure needs no kit import at runtime.

const RADIANS = Math.PI / 180;
const UNIT = Math.sqrt(1.6);

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type Projection = {
  origin: Vec2;
  scale: number;
  azimuth?: number;
  elevation?: number;
};

export function cameraOf({ scale, azimuth = 45, elevation = 30 }: Projection) {
  const a = azimuth * RADIANS;
  const e = elevation * RADIANS;
  return {
    sinA: Math.sin(a),
    cosA: Math.cos(a),
    sinE: Math.sin(e),
    cosE: Math.cos(e),
    k: scale * UNIT,
  };
}

export function iso([x, y, z]: Vec3, projection: Projection): Vec2 {
  const { origin } = projection;
  const { sinA, cosA, sinE, cosE, k } = cameraOf(projection);
  return [
    origin[0] + (x * sinA - y * cosA) * k,
    origin[1] + ((x * cosA + y * sinA) * sinE - z * cosE) * k,
  ];
}

const tenth = (value: number) => {
  const text = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return text === "-0" ? "0" : text;
};

export function pathOf(points: Vec2[], closed = false): string {
  if (!points.length) return "";
  return (
    points.map(([x, y], at) => `${at ? "L" : "M"}${tenth(x)} ${tenth(y)}`).join("") +
    (closed ? "Z" : "")
  );
}

const fine = (value: number) => Math.round(value * 100) / 100;

export function translateAlong(projection: Projection, by: Vec3): string {
  const origin = iso([0, 0, 0], projection);
  const moved = iso(by, projection);
  return `translate(${fine(moved[0] - origin[0])} ${fine(moved[1] - origin[1])})`;
}
