interface PanelResizingElements {
  workbench: HTMLElement;
  leftResizer: HTMLElement;
  rightResizer: HTMLElement;
}

type PanelSide = "left" | "right";

const LEFT_DEFAULT = 270;
const RIGHT_DEFAULT = 390;

export function setupColumnResizing({
  workbench,
  leftResizer,
  rightResizer,
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
    const minimum = side === "left" ? 210 : 300;
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

  const attachResizer = (
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

  setPanelWidth("left", storedWidth("left", LEFT_DEFAULT), false);
  setPanelWidth("right", storedWidth("right", RIGHT_DEFAULT), false);
  setPanelWidth("left", panelWidth("left"), false);

  attachResizer(leftResizer, "left", LEFT_DEFAULT);
  attachResizer(rightResizer, "right", RIGHT_DEFAULT);
  window.addEventListener("resize", () => {
    setPanelWidth("right", panelWidth("right"), false);
    setPanelWidth("left", panelWidth("left"), false);
  });
}
