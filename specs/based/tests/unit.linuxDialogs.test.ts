// Traces: BASED-DIALOG-OPEN-FILE
import { describe, expect, test } from "bun:test";
import { filterFor, linuxDialogCommand } from "../../../core/src/dialogs";

describe("Linux standalone file dialogs", () => {
  test("Zenity preserves filenames as one argument and applies SQL/all-file filters", () => {
    const name = "/tmp/O'Brien $(touch unsafe); draft.sql";
    expect(linuxDialogCommand({ kind: "save-file", defaultName: name, filters: filterFor("sql") }, "zenity"))
      .toEqual(["zenity", "--file-selection", "--save", "--confirm-overwrite", `--filename=${name}`,
        "--file-filter=SQL files | *.sql", "--file-filter=All files | *"]);
  });

  test("KDialog receives a start path and its native filter format", () => {
    expect(linuxDialogCommand({ kind: "open-file", filters: filterFor("csv") }, "kdialog"))
      .toEqual(["kdialog", "--getopenfilename", ".", "*.csv|CSV files\n*|All files"]);
  });

  test("folder selection starts inside the requested directory on both desktops", () => {
    const req = { kind: "folder" as const, startingFolder: "/home/ada/My data/" };
    expect(linuxDialogCommand(req, "zenity")).toEqual([
      "zenity", "--file-selection", "--directory", "--filename=/home/ada/My data/",
    ]);
    expect(linuxDialogCommand(req, "kdialog")).toEqual([
      "kdialog", "--getexistingdirectory", "/home/ada/My data/",
    ]);
  });
});
