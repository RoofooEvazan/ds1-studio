/** Match the renderer's device-pixel camera snap and the canvas's actual CSS size. */
export function canvasToWorld(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number },
  camera: { x: number; y: number; zoom: number },
): [number, number] {
  const z = camera.zoom;
  return [
    Math.round(camera.x * z) / z + ((clientX - rect.left) * canvas.width / rect.width - Math.floor(canvas.width / 2)) / z,
    Math.round(camera.y * z) / z + ((clientY - rect.top) * canvas.height / rect.height - Math.floor(canvas.height / 2)) / z,
  ];
}
