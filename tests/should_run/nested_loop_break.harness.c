/* Harness for nested_loop_break.fit. inner_sig always stops immediately, so the
   inner loop runs one iteration per outer iteration. outer_sig continues once,
   then stops — so INNER_DONE appears twice before OUTER_DONE. If an inner break
   escaped to the outer loop, OUTER_DONE would appear after a single INNER_DONE. */

#include <stdio.h>

typedef enum { Sig_Again = 0, Sig_Stop = 1 } Sig;
void nested_loops(void);

Sig inner_sig(void) { return Sig_Stop; }

static int outer_calls = 0;
Sig outer_sig(void) { return (++outer_calls >= 2) ? Sig_Stop : Sig_Again; }

void note_inner_done(void) { printf("INNER_DONE\n"); }
void note_outer_done(void) { printf("OUTER_DONE\n"); }

int main(void) { nested_loops(); return 0; }
