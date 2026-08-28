interface PanelResizingElements {
  workbench: HTMLElement;
  leftResizer: HTMLElement;
  rightResizer: HTMLElement;
  projectPanel: HTMLElement;
  projectRowResizer: HTMLElement;
  previewPanel: HTMLElement;
  previewRowResizer: HTMLElement;
}

type PanelSide = "left" | "right";
type RowPanel = "project" | "preview";

const LEFT_DEFAULT = 270;
const RIGHT_DEFAULT = 420;
const ROW_RESIZER_SIZE = 7;
const PROJECT_PRIMARY_MIN = 150;
const PROJECT_SECONDARY_MIN = 120;
const PREVIEW_PRIMARY_MIN = 160;
const PREVIEW_SECONDARY_MIN = 110;

export function clampSplitHeight(
  requestedHeight: number,
  availableHeight: number,
  primaryMinimum: number,
  secondaryMinimum: number,
): number {
  const maximum = Math.max(primaryMinimum, availableHeight - secondaryMinimum);
  return Math.round(Math.min(maximum, Math.max(primaryMinimum, requestedHeight)));
}

export function setupPanelResizing({
  workbench,
  leftResizer,
  rightResizer,
  projectPanel,
  projectRowResizer,
  previewPanel,
  previewRowResizer,
}: PanelResizingElements): void {
  const resizerFor = (side: PanelSide): HTMLElement =>
    side === "left" ? leftResizer : rightResizer;

  const panelWidth = (side: PanelSide): number => {
    const property = side === "left" ? "--left-panel-width" : "--right-panel-width";
    const value = getComputedStyle(workbench).getPropertyValue(property);
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : side === "left" ? LEFT_DEFAULT : RIGHT_DEFAULT;
  };

  const setPanelWidth = (side: PanelSide, requestedWidth: number, persist = true): void => {
    const minimum = side === "left" ? 210 : 360;
    const configuredMaximum = side === "left" ? 480 : 560;
    const otherWidth = panelWidth(side === "left" ? "right" : "left");
    const availableMaximum = workbench.clientWidth - otherWidth - 360 - 14;
    const maximum = Math.max(minimum, Math.min(configuredMaximum, availableMaximum));
    const width = Math.round(Math.min(maximum, Math.max(minimum, requestedWidth)));
    const property = side === "left" ? "--left-panel-width" : "--right-panel-width";
    const resizer = resizerFor(side);
    workbench.style.setProperty(property, `${width}px`);
    resizer.setAttribute("aria-valuenow", String(width));
    resizer.setAttribute("aria-valuemax", String(Math.round(maximum)));
    if (persist) {
      localStorage.setItem(`localforge.${side}PanelWidth`, String(width));
    }
  };

  const storedWidth = (side: PanelSide, fallback: number): number => {
    const parsed = Number.parseFloat(localStorage.getItem(`localforge.${side}PanelWidth`) ?? "");
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const attachColumnResizer = (
    resizer: HTMLElement,
    side: PanelSide,
    defaultWidth: number,
  ): void => {
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth(side);
      resizer.classList.add("active");
      document.body.classList.add("resizing-columns");
      resizer.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX;
        setPanelWidth(side, startWidth + (side === "left" ? delta : -delta));
      };
      const finish = (finishEvent: PointerEvent): void => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", finish);
        resizer.removeEventListener("pointercancel", finish);
        if (resizer.hasPointerCapture(finishEvent.pointerId)) {
          resizer.releasePointerCapture(finishEvent.pointerId);
        }
        resizer.classList.remove("active");
        document.body.classList.remove("resizing-columns");
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", finish);
      resizer.addEventListener("pointercancel", finish);
    });

    resizer.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setPanelWidth(side, panelWidth(side) + (side === "left" ? direction : -direction) * 12);
    });

    resizer.addEventListener("dblclick", () => setPanelWidth(side, defaultWidth));
  };

  const rowPanelFor = (panel: RowPanel): HTMLElement =>
    panel === "project" ? projectPanel : previewPanel;

  const rowResizerFor = (panel: RowPanel): HTMLElement =>
    panel === "project" ? projectRowResizer : previewRowResizer;

  const rowPropertyFor = (panel: RowPanel): string =>
    panel === "project" ? "--project-tree-height" : "--preview-content-height";

  const fixedRowHeight = (panel: RowPanel): number => {
    if (panel === "project") {
      return ROW_RESIZER_SIZE;
    }
    const header = previewPanel.querySelector<HTMLElement>(".preview-header");
    return (header?.offsetHeight ?? 48) + ROW_RESIZER_SIZE;
  };

  const availableRowHeight = (panel: RowPanel): number =>
    Math.max(0, rowPanelFor(panel).clientHeight - fixedRowHeight(panel));

  const defaultRowHeight = (panel: RowPanel): number => {
    const available = availableRowHeight(panel);
    return panel === "project"
      ? Math.round(available * 0.68)
      : Math.round(available - 200);
  };

  const rowHeight = (panel: RowPanel): number => {
    const value = getComputedStyle(rowPanelFor(panel)).getPropertyValue(rowPropertyFor(panel));
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : defaultRowHeight(panel);
  };

  const rowMinimums = (panel: RowPanel): [number, number] =>
    panel === "project"
      ? [PROJECT_PRIMARY_MIN, PROJECT_SECONDARY_MIN]
      : [PREVIEW_PRIMARY_MIN, PREVIEW_SECONDARY_MIN];

  const setRowHeight = (panel: RowPanel, requestedHeight: number, persist = true): void => {
    const available = availableRowHeight(panel);
    const [primaryMinimum, secondaryMinimum] = rowMinimums(panel);
    const height = clampSplitHeight(
      requestedHeight,
      available,
      primaryMinimum,
      secondaryMinimum,
    );
    const resizer = rowResizerFor(panel);
    rowPanelFor(panel).style.setProperty(rowPropertyFor(panel), `${height}px`);
    resizer.setAttribute("aria-valuenow", String(height));
    resizer.setAttribute("aria-valuemin", String(primaryMinimum));
    resizer.setAttribute(
      "aria-valuemax",
      String(Math.max(primaryMinimum, available - secondaryMinimum)),
    );
    resizer.setAttribute("aria-valuetext", `上方区域高度 ${height} 像素`);
    if (persist) {
      localStorage.setItem(`localforge.${panel}TopHeight`, String(height));
    }
  };

  const storedRowHeight = (panel: RowPanel): number => {
    const parsed = Number.parseFloat(localStorage.getItem(`localforge.${panel}TopHeight`) ?? "");
    return Number.isFinite(parsed) ? parsed : defaultRowHeight(panel);
  };

  const attachRowResizer = (resizer: HTMLElement, panel: RowPanel): void => {
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = rowHeight(panel);
      resizer.classList.add("active");
      document.body.classList.add("resizing-rows");
      resizer.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent): void => {
        setRowHeight(panel, startHeight + moveEvent.clientY - startY);
      };
      const finish = (finishEvent: PointerEvent): void => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", finish);
        resizer.removeEventListener("pointercancel", finish);
        if (resizer.hasPointerCapture(finishEvent.pointerId)) {
          resizer.releasePointerCapture(finishEvent.pointerId);
        }
        resizer.classList.remove("active");
        document.body.classList.remove("resizing-rows");
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", finish);
      resizer.addEventListener("pointercancel", finish);
    });

    resizer.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }
      event.preventDefault();
      setRowHeight(panel, rowHeight(panel) + (event.key === "ArrowDown" ? 12 : -12));
    });

    resizer.addEventListener("dblclick", () => setRowHeight(panel, defaultRowHeight(panel)));
  };

  setPanelWidth("left", storedWidth("left", LEFT_DEFAULT), false);
  setPanelWidth("right", storedWidth("right", RIGHT_DEFAULT), false);
  setPanelWidth("left", panelWidth("left"), false);
  setRowHeight("project", storedRowHeight("project"), false);
  setRowHeight("preview", storedRowHeight("preview"), false);

  attachColumnResizer(leftResizer, "left", LEFT_DEFAULT);
  attachColumnResizer(rightResizer, "right", RIGHT_DEFAULT);
  attachRowResizer(projectRowResizer, "project");
  attachRowResizer(previewRowResizer, "preview");
  window.addEventListener("resize", () => {
    setPanelWidth("right", panelWidth("right"), false);
    setPanelWidth("left", panelWidth("left"), false);
    setRowHeight("project", rowHeight("project"), false);
    setRowHeight("preview", rowHeight("preview"), false);
  });
}
