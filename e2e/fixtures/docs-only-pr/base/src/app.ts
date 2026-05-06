export function startApp(): string {
  return 'sunny-cactus app started';
}

if (import.meta.main) {
  console.log(startApp());
}
