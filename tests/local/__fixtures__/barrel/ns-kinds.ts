// Instantiated namespace: has a value member -> real runtime object.
export namespace HasValue {
  export const v = 1;
}

// Types-only namespace: erased by TS at emit -> no runtime binding.
export namespace TypesOnly {
  export interface I {
    x: number;
  }
  export type T = string;
}

// Nested: instantiated only via the nested value member.
export namespace NestedValue {
  export namespace Inner {
    export const w = 2;
  }
}

// Ambient: `declare` is erased regardless of members.
export declare namespace AmbientNs {
  const z: number;
}
