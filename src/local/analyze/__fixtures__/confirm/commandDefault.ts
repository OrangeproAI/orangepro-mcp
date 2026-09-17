class SfCommand<T> {
  public static async run(_argv: string[]): Promise<unknown> {
    return undefined;
  }
}

export default class AgentCommand extends SfCommand<string> {
  public async run(): Promise<string> {
    return "ok";
  }
}
