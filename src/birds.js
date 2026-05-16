// Tiny SVG bird flock that flies across the screen when the user taps.

const BIRD_SVG = `
<svg viewBox="0 0 40 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="bird-wing bird-wing-1" d="M2 10 Q10 0 20 10" />
  <path class="bird-wing bird-wing-2" d="M20 10 Q30 0 38 10" />
</svg>`;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export function releaseBirds(host, count = null) {
  // Auto count if not provided.
  const n = count ?? Math.floor(rand(6, 12));

  // Either left-to-right or right-to-left, pick one direction per flock.
  const direction = Math.random() < 0.5 ? 1 : -1;
  const baseY = rand(0.18, 0.55) * window.innerHeight;

  for (let i = 0; i < n; i++) {
    const bird = document.createElement("div");
    bird.className = "bird";
    bird.innerHTML = BIRD_SVG;

    const size = rand(18, 34);
    const startX = direction === 1 ? -80 : window.innerWidth + 80;
    const endX = direction === 1 ? window.innerWidth + 80 : -80;
    const yOffset = rand(-40, 40) + i * rand(8, 16);
    const duration = rand(5500, 8500);
    const delay = i * rand(80, 220);

    bird.style.setProperty("--size", `${size}px`);
    bird.style.setProperty("--start-x", `${startX}px`);
    bird.style.setProperty("--end-x", `${endX}px`);
    bird.style.setProperty("--start-y", `${baseY + yOffset}px`);
    bird.style.setProperty("--end-y", `${baseY + yOffset + rand(-30, 30)}px`);
    bird.style.setProperty("--duration", `${duration}ms`);
    bird.style.setProperty("--delay", `${delay}ms`);
    bird.style.setProperty("--flip", direction === 1 ? "1" : "-1");
    bird.style.setProperty("--flap", `${rand(180, 320)}ms`);

    host.appendChild(bird);

    // Cleanup once the animation completes.
    setTimeout(() => bird.remove(), duration + delay + 500);
  }
}
