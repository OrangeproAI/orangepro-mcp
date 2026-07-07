// Ambient (`declare`) declarations in a REGULAR .ts file: erased at emit, no
// runtime binding — must never be COVERS-eligible. realTsFn is the control.
export declare function ambientTsFn(): void;
export declare class AmbientTsCls {}
export declare const ambientTsConst: number;
export declare namespace AmbientTsNs {
  const inner: number;
}
export function realTsFn(): number {
  return 1;
}
