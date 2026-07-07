type Class<T> = new (...args: never[]) => T;

type Provider<T> =
  | Class<T>
  | {
      provide: Class<T>;
      useValue?: T;
      useClass?: Class<T>;
    };

export class Test {
  static createTestingModule(config: { providers: Provider<unknown>[] }): TestingModuleBuilder {
    return new TestingModuleBuilder(config.providers);
  }
}

class TestingModuleBuilder {
  private readonly overrides = new Map<Class<unknown>, Provider<unknown>>();

  constructor(private readonly providers: Provider<unknown>[]) {}

  overrideProvider<T>(token: Class<T>): { useValue: (value: T) => TestingModuleBuilder; useClass: (klass: Class<T>) => TestingModuleBuilder } {
    return {
      useValue: (value: T) => {
        this.overrides.set(token, { provide: token, useValue: value });
        return this;
      },
      useClass: (klass: Class<T>) => {
        this.overrides.set(token, { provide: token, useClass: klass });
        return this;
      }
    };
  }

  async compile(): Promise<TestingModule> {
    return new TestingModule(this.providers, this.overrides);
  }
}

class TestingModule {
  private readonly instances = new Map<Class<unknown>, unknown>();

  constructor(providers: Provider<unknown>[], overrides: Map<Class<unknown>, Provider<unknown>>) {
    for (const provider of [...providers, ...overrides.values()]) {
      if (typeof provider === "function") {
        this.instances.set(provider, new provider());
      } else if (provider.useValue) {
        this.instances.set(provider.provide, provider.useValue);
      } else if (provider.useClass) {
        this.instances.set(provider.provide, new provider.useClass());
      } else {
        this.instances.set(provider.provide, new provider.provide());
      }
    }
  }

  get<T>(token: Class<T>): T {
    const instance = this.instances.get(token);
    if (!instance) {
      throw new Error(`Provider not found: ${token.name}`);
    }
    return instance as T;
  }
}
