/* Harness for expr_arithmetic_runtime.fit. print_int prints its argument followed by
   a newline; compute_and_print calls it once for each of the two expressions. */

#include <stdio.h>

typedef int Int;

void compute_and_print(void);

void print_int(Int n) { printf("%d\n", n); }

int main(void) { compute_and_print(); return 0; }
