/* payment_stubs.c — stubs for payment.fit */
#include <stdio.h>
#include <string.h>

/*
 * Plain types: the generated C emits `typedef int <Name>` for each.
 * Redeclaring compatible typedefs here (same underlying type) is safe in C —
 * each TU is independently compiled and `typedef int X` in two TUs is legal.
 */
typedef int CardDetails;
typedef int Cents;
typedef int Receipt;
typedef int TokenId;

/* AuthToken: resource struct, defined in generated C — redeclare compatible typedef here */
typedef struct { int token_id; } AuthToken;
extern void void_token(AuthToken v); /* defined below */

typedef enum {
    PaymentError_Declined      = 0,
    PaymentError_NetworkFail   = 1,
    PaymentError_InvalidCard   = 2,
    PaymentError_AlreadyCharged = 3
} PaymentError;

typedef struct { int tag; union { AuthToken ok; PaymentError err; }; } R_AuthToken_PaymentError;
typedef struct { int tag; union { Receipt   ok; PaymentError err; }; } R_Receipt_PaymentError;
typedef struct { int tag; union { int       ok; PaymentError err; }; } R_int_PaymentError;

/* Forward-declare process_payment (defined in generated .c) */
R_Receipt_PaymentError process_payment(CardDetails card, Cents amount);

/* Observable cleanup log: each cleanup fn appends its name */
static char cleanup_log[256] = "";

/* Global flag: 1 → execute_charge returns Err, 0 → returns Ok */
static int charge_should_fail = 0;

/*
 * validate_card: one param (card only).
 * `using Net` is a capability clause — NOT a C parameter.
 */
R_AuthToken_PaymentError validate_card(CardDetails card) {
    (void)card;
    AuthToken t = {1};
    return (R_AuthToken_PaymentError){0, {.ok = t}};
}

/*
 * execute_charge: receives token by move.
 * On failure, this stub owns the token and must call void_token before returning Err.
 * process_payment will NOT call void_token — it has already moved token out.
 */
R_Receipt_PaymentError execute_charge(AuthToken token, Cents amount) {
    (void)amount;
    if (charge_should_fail) {
        void_token(token); /* token is owned here; clean it up before returning Err */
        return (R_Receipt_PaymentError){1, {.err = PaymentError_Declined}};
    }
    /* On success, token is consumed (representing the charge transaction) */
    (void)token;
    return (R_Receipt_PaymentError){0, {.ok = 99}};
}

R_int_PaymentError audit_log(Receipt receipt) {
    (void)receipt;
    return (R_int_PaymentError){0, {.ok = 0}};
}

void void_token(AuthToken t) {
    (void)t;
    strcat(cleanup_log, "void_token ");
}

int main(void) {
    int pass = 1;

    /*
     * Path 1: execute_charge fails.
     * void_token must fire INSIDE execute_charge (token was moved in; process_payment
     * no longer owns it and emits no cleanup call for it).
     */
    cleanup_log[0] = '\0';
    charge_should_fail = 1;
    process_payment(0, 100);
    if (strcmp(cleanup_log, "void_token ") == 0) {
        printf("PASS payment[charge fails]: void_token fired inside execute_charge\n");
    } else {
        printf("FAIL payment[charge fails]: got '%s'\n", cleanup_log);
        pass = 0;
    }

    /*
     * Path 2: success.
     * void_token must NOT fire — token was consumed by execute_charge on the success path,
     * and process_payment correctly does not emit any cleanup call for it.
     */
    cleanup_log[0] = '\0';
    charge_should_fail = 0;
    process_payment(0, 100);
    if (strcmp(cleanup_log, "") == 0) {
        printf("PASS payment[success]: void_token did not fire in process_payment\n");
    } else {
        printf("FAIL payment[success]: got '%s'\n", cleanup_log);
        pass = 0;
    }

    return pass ? 0 : 1;
}
