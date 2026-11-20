export class Address {
  constructor(public readonly text: string) {}
}

export function createAddress(input: string): Address {
  return new Address(input.trim());
}
