// Basic loader orchestration.
//
// Sequence:
//   1. Three dots bounce in a straight line.
//   2. The gap collapses so they merge together.
//   3. The dots fade out, then the white loader screen — split into
//      vertical columns — slides up column-by-column with a slight
//      delay, revealing the grey site behind it (staircase effect).

document.addEventListener("DOMContentLoaded", () => {
    const loaderIcons = document.getElementById("loaderIcons");
    const columns = document.querySelectorAll(".loader-column");

    // Timing (ms)
    const MERGE_START = 1000; // after dots have bounced for a bit
    const REVEAL_START = 2000; // when columns begin sliding up
    const COLUMN_STAGGER = 120; // delay between each column

    // Step 2: merge the three dots into one
    window.setTimeout(() => {
        loaderIcons.classList.add("is-merging");
    }, MERGE_START);

    // Step 3: hide the dots, then slide each column up in sequence
    window.setTimeout(() => {
        loaderIcons.classList.add("is-hidden");

        columns.forEach((column, index) => {
            window.setTimeout(() => {
                column.classList.add("is-revealed");
            }, index * COLUMN_STAGGER);
        });
    }, REVEAL_START);
});
