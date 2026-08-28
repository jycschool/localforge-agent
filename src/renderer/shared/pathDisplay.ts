export function displayLocalPath(value: string): string {
  const windowsHome = value.match(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i);
  if (windowsHome) {
    return `~${value.slice(windowsHome[0].length)}`;
  }
  const posixHome = value.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/);
  return posixHome ? `~${value.slice(posixHome[0].length)}` : value;
}
