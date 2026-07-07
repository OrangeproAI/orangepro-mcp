export interface CalcResult {
  value: number;
  source: "real" | "mutant";
}

export class CalcService {
  add(a: number, b: number): CalcResult {
    return { value: a + b, source: "real" };
  }
}
