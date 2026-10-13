import { describe, it, expect } from "vitest";
import { serialSigner, trackSigner } from "../serial-signer";

/** A signer whose answers the test hands out one by one. */
function fakeWallet() {
  const started: string[] = [];
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const sign = (tx: string) =>
    new Promise<string>((resolve, reject) => {
      started.push(tx);
      pending.set(tx, { resolve, reject });
    });
  return { sign, started, answer: (tx: string) => pending.get(tx)!.resolve(`signed:${tx}`), refuse: (tx: string) => pending.get(tx)!.reject(new Error("User rejected")) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("serialSigner", () => {
  it("asks the wallet once at a time, in call order", async () => {
    const w = fakeWallet();
    const turn = serialSigner();
    const sign = (tx: string) => turn(() => w.sign(tx));
    const a = sign("a");
    const b = sign("b");
    await flush();
    expect(w.started).toEqual(["a"]);
    w.answer("a");
    expect(await a).toBe("signed:a");
    await flush();
    expect(w.started).toEqual(["a", "b"]);
    w.answer("b");
    expect(await b).toBe("signed:b");
  });

  it("goes on after a refusal, and the refusal reaches its own caller", async () => {
    const w = fakeWallet();
    const turn = serialSigner();
    const sign = (tx: string) => turn(() => w.sign(tx));
    const a = sign("a");
    const b = sign("b");
    await flush();
    w.refuse("a");
    await expect(a).rejects.toThrow("User rejected");
    await flush();
    expect(w.started).toEqual(["a", "b"]);
    w.answer("b");
    expect(await b).toBe("signed:b");
  });

  it("runs what it is handed at the turn, not what was true when the turn was taken", async () => {
    const w = fakeWallet();
    const turn = serialSigner();
    let wanted = true;
    const a = turn(() => w.sign("a"));
    const b = turn(() => (wanted ? w.sign("b") : Promise.reject(new Error("withdrawn"))));
    await flush();
    wanted = false;
    w.answer("a");
    await a;
    await expect(b).rejects.toThrow("withdrawn");
    expect(w.started).toEqual(["a"]);
  });
});

describe("trackSigner", () => {
  it("says whether this job's signer was never asked, signed, or threw", async () => {
    const w = fakeWallet();
    const idle = trackSigner(w.sign);
    expect(idle.state()).toBe("none");

    const signs = trackSigner(w.sign);
    const s = signs.sign("s");
    await flush();
    expect(signs.state()).toBe("none");
    w.answer("s");
    expect(await s).toBe("signed:s");
    expect(signs.state()).toBe("signed");

    const throws = trackSigner(w.sign);
    const t = throws.sign("t");
    await flush();
    w.refuse("t");
    await expect(t).rejects.toThrow("User rejected");
    expect(throws.state()).toBe("threw");
  });
});
