/* Harness for expr_div_left_always_evaluated.fit. Instruments the resource lifecycle
   with two counters: `opened` (make_conn calls) and `used` (use_conn calls — this
   test's stand-in for "the resource was consumed/disposed of"). run() always divides
   by 0, forcing the DivByZero error path. Before the Critical fix, the left operand of
   `/` (the use_conn(c) call) was only reachable on the nonzero-divisor branch of the
   generated C, so `used` would stay 0 here; after the fix it is unconditional. */

#include <stdio.h>

typedef int Int;

typedef struct {
  int id;
} Conn;

static int opened = 0;
static int used = 0;

void run(void);

Conn make_conn(void) {
  opened++;
  Conn c;
  c.id = 42;
  return c;
}

void close_conn(Conn c) {
  /* Not expected to be called in this test — c is always consumed by use_conn's move
     param before any scope-exit cleanup would fire. Present only to satisfy the
     resource's extern cleanup declaration. */
  (void)c;
}

Int use_conn(Conn c) {
  used++;
  return c.id;
}

void report(void) {
  printf("opened=%d used=%d\n", opened, used);
}

int main(void) {
  run();
  return 0;
}
