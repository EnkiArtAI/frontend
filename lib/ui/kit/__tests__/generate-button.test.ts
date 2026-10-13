import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

// The button's only hook is a ref: a plain box lets the component run as a
// function, and its click handler be pressed directly.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(current: T) => ({ current }),
}));

import GenerateButton from "@/components/kit/GenerateButton";

type Button = ReactElement<{
  onClick: (e: { timeStamp: number }) => void; "aria-disabled"?: boolean; disabled?: boolean; "data-short"?: boolean; title?: string;
  children: [string, ReactElement<{ className: string; children: [ReactElement<{ children: [string, string] }> | false, string] }>];
}>;

const mount = (dimmed: boolean, short: string | null = null) => {
  const onPress = vi.fn();
  const button = GenerateButton({ label: "✦ Generate", chip: "$0.147", dimmed, onPress, size: "block", short }) as Button;
  return { onPress, button, press: (t: number) => button.props.onClick({ timeStamp: t }) };
};

describe("GenerateButton", () => {
  it("drops a press within 350 ms of the last accepted one, so a double click pays once", () => {
    const { onPress, press } = mount(false);
    press(1000);
    press(1200);
    press(1350);
    press(1500);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("only looks disabled when dimmed: the press still reaches the surface", () => {
    const { onPress, button, press } = mount(true);
    expect(button.props["aria-disabled"]).toBe(true);
    expect(button.props.disabled).toBeUndefined();
    press(0);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("a short balance marks the button and puts the balance beside the price in the chip (Kev, 2026-10-13)", () => {
    const { button } = mount(false, "$0.00");
    expect(button.props["data-short"]).toBe(true);
    const chip = button.props.children[1];
    expect(chip.props.className).toBe("kit-gen-chip");
    expect(chip.props.children[0]).toMatchObject({ props: { className: "kit-gen-short", children: ["Balance ", "$0.00"] } });
    expect(chip.props.children[1]).toBe("$0.147");
  });

  it("with the balance in order the chip is the price alone and nothing marks the button", () => {
    const { button } = mount(false);
    expect(button.props["data-short"]).toBeUndefined();
    expect(button.props.children[1].props.children).toEqual([false, "$0.147"]);
  });
});
