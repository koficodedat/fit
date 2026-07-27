/* Harness for break_in_match_in_loop.fit — demonstrates that the loop never
   exits. Supplies the externs the generated C declares, plus main().
   Expected (buggy) behaviour: runs forever, killed by timeout.
   Expected behaviour once the defect is fixed: prints REACHED_FINISH then
   RETURNED, exit 0. */

#include <stdio.h>

typedef enum { Event_More = 0, Event_Done = 1 } Event;
void drain_events(void);

static int calls = 0;

Event next_event(void) {
    return (++calls >= 3) ? Event_Done : Event_More;
}

void finish(void) {
    printf("REACHED_FINISH\n");
}

int main(void) {
    drain_events();
    printf("RETURNED\n");
    return 0;
}
