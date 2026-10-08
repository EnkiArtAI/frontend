import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

// The button's only hook is a ref: a plain box lets the component run as a
// function, and its click handler be pressed directly.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(current: T) => ({ current }),
}));

import GenerateButton from "@/components/kit/GenerateButton";

type Button = ReactElement<{ onClick: (e: { timeStamp: number }) => void; "aria-disabled"?: boolean; disabled?: boolean }>;

const mount = (dimmed: boolean) => {
  const onPress = vi.fn();
  const button = GenerateButton({ label: "✦ Generate", chip: "$0.147", dimmed, onPress, size: "block" }) as Button;
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
});
