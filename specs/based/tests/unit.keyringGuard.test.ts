// Traces: BASED-SECRET-STORE — the Linux keyring availability guard.
// The guard must run BEFORE any @napi-rs/keyring call: with no session D-Bus the native library
// segfaults the Bun process rather than throwing (observed Bun 1.3.14, WSL2 Ubuntu 24.04), so this
// cannot be a catch — it has to be a pre-check. Pure function, so every branch runs on any host.
import { describe, expect, test } from "bun:test";
import { keyringUnavailableReason } from "@based/core";

const noSocket = () => false;

describe("BASED-SECRET-STORE: keyringUnavailableReason", () => {
  test("win32 and darwin are always available — their keychains are not D-Bus services", () => {
    expect(keyringUnavailableReason("win32", {}, noSocket)).toBeNull();
    expect(keyringUnavailableReason("darwin", {}, noSocket)).toBeNull();
  });

  test("linux with DBUS_SESSION_BUS_ADDRESS set is available", () => {
    expect(
      keyringUnavailableReason("linux", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, noSocket),
    ).toBeNull();
  });

  test("linux with no bus address but a live $XDG_RUNTIME_DIR/bus socket is available", () => {
    const seen: string[] = [];
    const result = keyringUnavailableReason("linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, (p) => {
      seen.push(p);
      return true;
    });
    expect(result).toBeNull();
    expect(seen).toEqual(["/run/user/1000/bus"]);
  });

  test("linux with XDG_RUNTIME_DIR but no bus socket is unavailable, naming D-Bus", () => {
    expect(keyringUnavailableReason("linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, noSocket)).toMatch(/D-Bus/);
  });

  test("linux with neither variable is unavailable — the WSL2 default", () => {
    const reason = keyringUnavailableReason("linux", {}, noSocket);
    expect(reason).toMatch(/keyring service is unavailable/);
    expect(reason).toMatch(/DBUS_SESSION_BUS_ADDRESS/);
  });

  test("an empty DBUS_SESSION_BUS_ADDRESS does not count as a bus", () => {
    expect(keyringUnavailableReason("linux", { DBUS_SESSION_BUS_ADDRESS: "" }, noSocket)).not.toBeNull();
  });

  test("BASED_KEYRING=off disables the keyring on every platform, even with a bus present", () => {
    // The bus check can pass while no Secret Service exists behind it (WSL2 with systemd) — the
    // kill-switch is the operator's way out when detection is wrong.
    expect(
      keyringUnavailableReason(
        "linux",
        { BASED_KEYRING: "off", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
        () => true,
      ),
    ).toMatch(/BASED_KEYRING=off/);
    expect(keyringUnavailableReason("win32", { BASED_KEYRING: "off" }, noSocket)).toMatch(/BASED_KEYRING=off/);
  });
});
