// WHETHER THE ITEM TABS SHOW IN THE TOP BAR (AFB-20261112-2350)
// On a wide screen the tab card stays in the item page and scrolls away like any card. Once it has scrolled past the top bar, the
// same tabs appear in the bar. The item page watches its card and writes here; the layout, which draws the bar, reads it.

// -- STATES -- //

export const itemTabsBar = $state({ show: false });
