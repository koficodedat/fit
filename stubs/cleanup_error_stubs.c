/* cleanup_error_stubs.c — stubs for cleanup_error.fit */
#include <stdio.h>
#include <string.h>

/*
 * Types must match codegen output exactly.
 * Widget: struct { int id; }
 * E: enum { E_Failed = 0 }
 * R_int_E: Result<(),E> — unit lowers to int, so ok field is int
 */
typedef struct { int id; } Widget;
extern void free_widget(Widget v); /* defined below */

typedef enum { E_Failed = 0 } E;

typedef struct {
    int tag;
    union { int ok; E err; };
} R_int_E;

extern R_int_E run(void); /* defined in generated .c */

/* Observable cleanup log: each cleanup fn appends its name */
static char cleanup_log[256] = "";

/* Global flag: 1 → risky() returns Err, 0 → returns Ok */
static int risky_should_fail = 0;

Widget make_widget(void) {
    Widget w = {42};
    return w;
}

R_int_E risky(void) {
    if (risky_should_fail) {
        return (R_int_E){1, {.err = E_Failed}};
    }
    return (R_int_E){0, {.ok = 0}};
}

void free_widget(Widget w) {
    (void)w;
    strcat(cleanup_log, "free_widget ");
}

int main(void) {
    int pass = 1;

    /* Path 1: risky() returns Err — free_widget must fire on error path before return */
    cleanup_log[0] = '\0';
    risky_should_fail = 1;
    run();
    if (strcmp(cleanup_log, "free_widget ") == 0) {
        printf("PASS cleanup_error[err path]: free_widget fired before Err return\n");
    } else {
        printf("FAIL cleanup_error[err path]: got '%s'\n", cleanup_log);
        pass = 0;
    }

    /* Path 2: risky() returns Ok — free_widget must fire at drop, not on error path */
    cleanup_log[0] = '\0';
    risky_should_fail = 0;
    run();
    if (strcmp(cleanup_log, "free_widget ") == 0) {
        printf("PASS cleanup_error[ok path]: free_widget fired once at drop\n");
    } else {
        printf("FAIL cleanup_error[ok path]: got '%s'\n", cleanup_log);
        pass = 0;
    }

    return pass ? 0 : 1;
}
