/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* SPDX-FileCopyrightText: 2026 Leonardo Boulay */
/*
 * Modified work: Seedlab Ethereum scalar exporter, 2026-11-03.
 * This is a separate tool based on pzsolve's pzcore; it is not the original
 * pzsolve and is not made or endorsed by Leonardo Boulay.
 * See pzsolve-LICENSE.txt and pzsolve-NOTICE.txt.
 */
#define _GNU_SOURCE
#include <pzcore/ec.h>
#include <pzcore/u256.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#include "keccak256.h"

#define ROW_BYTES 110u
#define DEFAULT_THREADS 2
#define DEFAULT_CHUNK 4096u
#define MAX_CHUNK 65536u

static volatile sig_atomic_t g_interrupted = 0;

static void on_signal(int signal_number)
{
    (void)signal_number;
    g_interrupted = 1;
}

static void wipe(void *buffer, size_t length)
{
    volatile uint8_t *bytes = (volatile uint8_t *)buffer;
    while (length--) *bytes++ = 0;
}

static void hex_encode(const uint8_t *bytes, size_t length, char *output)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < length; i++) {
        output[2 * i] = digits[bytes[i] >> 4];
        output[2 * i + 1] = digits[bytes[i] & 15];
    }
}

static void ethereum_address(const pz_ge *point, char output[42])
{
    uint8_t public_key[64], digest[32], lowercase_hash[32];
    char lowercase[40];
    pz_fe_to_be(public_key, &point->x);
    pz_fe_to_be(public_key + 32, &point->y);
    seedlab_keccak256(public_key, sizeof public_key, digest);
    hex_encode(digest + 12, 20, lowercase);
    seedlab_keccak256((const uint8_t *)lowercase, sizeof lowercase, lowercase_hash);

    output[0] = '0';
    output[1] = 'x';
    static const char upper[] = "0123456789ABCDEF";
    for (unsigned i = 0; i < 40; i++) {
        const uint8_t hash_nibble = (i & 1) ? lowercase_hash[i / 2] & 15 : lowercase_hash[i / 2] >> 4;
        const char character = lowercase[i];
        output[2 + i] = (hash_nibble >= 8 && character >= 'a') ? upper[character - 'a' + 10] : character;
    }
}

static void format_row(char output[ROW_BYTES], const pz_u256 *scalar, const pz_ge *point)
{
    uint8_t private_bytes[32];
    ethereum_address(point, output);
    output[42] = '\t';
    output[43] = '0';
    output[44] = 'x';
    pz_u256_to_be(scalar, private_bytes);
    hex_encode(private_bytes, sizeof private_bytes, output + 45);
    output[109] = '\n';
    wipe(private_bytes, sizeof private_bytes);
}

static bool parse_decimal(pz_u256 *result, const char *text)
{
    if (!text || !*text) return false;
    for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return false;

    pz_u256 value = pz_u256_zero();
    pz_u256 maximum = {{UINT64_MAX, UINT64_MAX, UINT64_MAX, UINT64_MAX}};
    uint32_t maximum_digit = 0;
    const pz_u256 maximum_before_multiply = pz_u256_divmod_u32(&maximum, 10, &maximum_digit);
    for (const char *p = text; *p; p++) {
        const uint32_t digit = (uint32_t)(*p - '0');
        const int comparison = pz_u256_cmp(&value, &maximum_before_multiply);
        if (comparison > 0 || (comparison == 0 && digit > maximum_digit)) return false;
        value = pz_u256_mul_u32(&value, 10);
        pz_u256_add_u64(&value, &value, digit);
    }
    *result = value;
    return true;
}

static bool parse_u64_option(uint64_t *result, const char *text, uint64_t minimum, uint64_t maximum)
{
    if (!text || !*text) return false;
    char *end = NULL;
    errno = 0;
    const unsigned long long value = strtoull(text, &end, 10);
    if (errno || !end || *end || value < minimum || value > maximum) return false;
    *result = (uint64_t)value;
    return true;
}

typedef struct {
    pz_u256 lower;
    uint64_t total;
    uint64_t chunk_size;
    int fd;
    atomic_uint_fast64_t next_chunk;
    atomic_uint_fast64_t completed;
    atomic_bool failed;
    atomic_int error_number;
} export_job;

static void fail_job(export_job *job, int error_number)
{
    bool expected = false;
    if (atomic_compare_exchange_strong(&job->failed, &expected, true)) {
        atomic_store(&job->error_number, error_number);
    }
}

static bool write_all_at(export_job *job, const char *bytes, size_t length, uint64_t offset)
{
    size_t written = 0;
    while (written < length) {
        const ssize_t result = pwrite(job->fd, bytes + written, length - written, (off_t)(offset + written));
        if (result < 0) {
            if (errno == EINTR) continue;
            fail_job(job, errno);
            return false;
        }
        if (result == 0) {
            fail_job(job, EIO);
            return false;
        }
        written += (size_t)result;
    }
    return true;
}

static void *export_worker(void *argument)
{
    export_job *job = (export_job *)argument;
    const size_t point_count = (size_t)job->chunk_size;
    pz_gej *jacobian = malloc(sizeof(*jacobian) * point_count);
    pz_ge *affine = malloc(sizeof(*affine) * point_count);
    char *rows = malloc(ROW_BYTES * point_count);
    if (!jacobian || !affine || !rows) {
        fail_job(job, ENOMEM);
        goto cleanup;
    }

    while (!g_interrupted && !atomic_load(&job->failed)) {
        const uint64_t chunk_index = atomic_fetch_add(&job->next_chunk, 1);
        const uint64_t offset = chunk_index * job->chunk_size;
        if (offset >= job->total) break;
        const uint64_t remaining = job->total - offset;
        const uint64_t count = remaining < job->chunk_size ? remaining : job->chunk_size;

        pz_u256 scalar;
        const pz_u256 offset_scalar = pz_u256_from_u64(offset);
        pz_u256_add(&scalar, &job->lower, &offset_scalar);
        pz_ge initial;
        if (!pz_ec_mul_g(&initial, &scalar)) {
            fail_job(job, EINVAL);
            break;
        }
        pz_gej_set_ge(&jacobian[0], &initial);
        for (uint64_t i = 1; i < count; i++) pz_gej_add_ge(&jacobian[i], &jacobian[i - 1], &pz_ec_g);
        if (!pz_gej_to_ge_batch(affine, jacobian, (size_t)count)) {
            fail_job(job, EINVAL);
            break;
        }
        for (uint64_t i = 0; i < count; i++) {
            format_row(rows + i * ROW_BYTES, &scalar, &affine[i]);
            pz_u256_add_u64(&scalar, &scalar, 1);
        }
        if (!write_all_at(job, rows, (size_t)(count * ROW_BYTES), offset * ROW_BYTES)) break;
        atomic_fetch_add(&job->completed, count);
        wipe(&scalar, sizeof scalar);
    }

cleanup:
    if (rows) wipe(rows, ROW_BYTES * point_count);
    free(rows);
    free(affine);
    free(jacobian);
    return NULL;
}

static double monotonic_seconds(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static void print_version(void)
{
    puts("seedlab-eth-export 1.0.0 (modified work based on pzsolve pzcore)");
    puts("Copyright (C) 2026 Leonardo Boulay");
    puts("License: GNU AGPL version 3 or later, with the additional terms of the NOTICE file (section 7 of the AGPL).");
    puts("This is free software: you may use, study, change and share it under those terms. There is NO WARRANTY.");
    puts("Source code and NOTICE: https://github.com/boulayo/bitcoin-puzzle-solver");
    puts("This modified exporter is a Seedlab work dated 2026-11-03; it is not the original pzsolve and is not endorsed by Leonardo Boulay.");
}

static int selftest(void)
{
    static const char expected_empty[] = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
    static const char expected_row[] =
        "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf\t"
        "0x0000000000000000000000000000000000000000000000000000000000000001\n";
    uint8_t digest[32];
    char digest_hex[64], row[ROW_BYTES];
    seedlab_keccak256((const uint8_t *)"", 0, digest);
    hex_encode(digest, sizeof digest, digest_hex);
    if (memcmp(digest_hex, expected_empty, 64) != 0) {
        fputs("Keccak self-test failed.\n", stderr);
        return 1;
    }
    pz_ec_init();
    format_row(row, &(pz_u256){{1, 0, 0, 0}}, &pz_ec_g);
    if (memcmp(row, expected_row, ROW_BYTES) != 0) {
        fputs("Ethereum address/EIP-55 self-test failed.\n", stderr);
        return 1;
    }
    puts("Native exporter self-tests passed: Keccak-256, secp256k1, Ethereum address, EIP-55, row format.");
    return 0;
}

static void usage(FILE *stream)
{
    fputs("Generate every Ethereum address and private key in an inclusive scalar range.\n\n"
          "Usage: seedlab-eth-export --start N --end N --output FILE [options]\n\n"
          "  --start N       Inclusive decimal lower scalar (required)\n"
          "  --end N         Inclusive decimal upper scalar (required)\n"
          "  --output FILE   New TXT path; never overwritten (required)\n"
          "  --threads N     Parallel workers, 1-32 (default: 2)\n"
          "  --chunk-size N  Rows per batch, 1-65536 (default: 4096)\n"
          "  --selftest      Verify Keccak, key 1, EIP-55 and fixed-width row format\n"
          "  --version       Print license and modified-work notices\n"
          "  --help          Show this help\n\n"
          "Each 110-byte row is address<TAB>0x-private-key<LF>, with no header.\n"
          "Interrupted or failed output remains FILE.partial. Keep the TXT secret.\n", stream);
}

int main(int argc, char **argv)
{
    const char *start_text = NULL, *end_text = NULL, *output = NULL;
    uint64_t threads = DEFAULT_THREADS, chunk_size = DEFAULT_CHUNK;
    for (int i = 1; i < argc; i++) {
        const char *argument = argv[i];
        if (!strcmp(argument, "--help")) { usage(stdout); return 0; }
        if (!strcmp(argument, "--version")) { print_version(); return 0; }
        if (!strcmp(argument, "--selftest")) return selftest();
        if (!strcmp(argument, "--start") && i + 1 < argc) start_text = argv[++i];
        else if (!strcmp(argument, "--end") && i + 1 < argc) end_text = argv[++i];
        else if (!strcmp(argument, "--output") && i + 1 < argc) output = argv[++i];
        else if (!strcmp(argument, "--threads") && i + 1 < argc) {
            if (!parse_u64_option(&threads, argv[++i], 1, 32)) { fputs("Invalid --threads.\n", stderr); return 1; }
        } else if (!strcmp(argument, "--chunk-size") && i + 1 < argc) {
            if (!parse_u64_option(&chunk_size, argv[++i], 1, MAX_CHUNK)) { fputs("Invalid --chunk-size.\n", stderr); return 1; }
        } else {
            fprintf(stderr, "Unknown or incomplete argument: %s\n", argument);
            usage(stderr);
            return 1;
        }
    }
    if (!start_text || !end_text || !output || !*output) {
        usage(stderr);
        return 1;
    }

    export_job job;
    memset(&job, 0, sizeof job);
    pz_u256 upper;
    if (!parse_decimal(&job.lower, start_text) || !parse_decimal(&upper, end_text) ||
        pz_u256_is_zero(&job.lower) || pz_u256_cmp(&job.lower, &upper) > 0 ||
        pz_u256_cmp(&upper, &pz_secp256k1_n) >= 0) {
        fputs("Use 1 <= start <= end < the secp256k1 group order.\n", stderr);
        return 1;
    }
    pz_u256 count;
    pz_u256_sub(&count, &upper, &job.lower);
    pz_u256_add_u64(&count, &count, 1);
    if (count.w[1] || count.w[2] || count.w[3] || count.w[0] > (uint64_t)LLONG_MAX / ROW_BYTES) {
        fputs("The requested row count or output file is too large for this host.\n", stderr);
        return 1;
    }
    job.total = count.w[0];
    job.chunk_size = chunk_size;
    atomic_init(&job.next_chunk, 0);
    atomic_init(&job.completed, 0);
    atomic_init(&job.failed, false);
    atomic_init(&job.error_number, 0);

    struct stat status;
    if (stat(output, &status) == 0) {
        fprintf(stderr, "Output already exists: %s\n", output);
        return 1;
    }
    if (errno != ENOENT) {
        perror("Cannot inspect output");
        return 1;
    }
    const size_t partial_length = strlen(output) + sizeof ".partial";
    char *partial = malloc(partial_length);
    if (!partial) { fputs("Out of memory.\n", stderr); return 1; }
    snprintf(partial, partial_length, "%s.partial", output);
    job.fd = open(partial, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (job.fd < 0) {
        perror("Cannot create partial output");
        free(partial);
        return 1;
    }
    if (ftruncate(job.fd, (off_t)(job.total * ROW_BYTES)) != 0) {
        perror("Cannot size partial output");
        close(job.fd);
        free(partial);
        return 1;
    }

    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = on_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);

    pz_ec_init();
    pthread_t *workers = calloc((size_t)threads, sizeof(*workers));
    if (!workers) {
        close(job.fd);
        free(partial);
        fputs("Out of memory.\n", stderr);
        return 1;
    }
    const double started = monotonic_seconds();
    size_t created = 0;
    for (; created < (size_t)threads; created++) {
        const int error = pthread_create(&workers[created], NULL, export_worker, &job);
        if (error) {
            fail_job(&job, error);
            break;
        }
    }

    double last_report = started;
    while (!g_interrupted && !atomic_load(&job.failed) && atomic_load(&job.completed) < job.total) {
        const double now = monotonic_seconds();
        if (now - last_report >= 1.0) {
            const uint64_t completed = atomic_load(&job.completed);
            const double elapsed = now - started;
            const long double percent = (long double)completed * 100.0L / (long double)job.total;
            fprintf(stderr, "\rGenerated %llu / %llu rows (%.8Lf%%) · %.0f rows/s",
                    (unsigned long long)completed, (unsigned long long)job.total, percent,
                    elapsed > 0 ? (double)completed / elapsed : 0.0);
            fflush(stderr);
            last_report = now;
        }
        const struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000 };
        nanosleep(&pause, NULL);
    }
    for (size_t i = 0; i < created; i++) pthread_join(workers[i], NULL);
    free(workers);

    const uint64_t completed = atomic_load(&job.completed);
    const double elapsed = monotonic_seconds() - started;
    const double rate = elapsed > 0 ? (double)completed / elapsed : 0.0;
    fprintf(stderr, "\rGenerated %llu / %llu rows · %.0f rows/s in %.3f s\n",
            (unsigned long long)completed, (unsigned long long)job.total, rate, elapsed);

    int result = 1;
    if (g_interrupted) {
        fputs("Export interrupted; the .partial file is incomplete.\n", stderr);
    } else if (atomic_load(&job.failed)) {
        errno = atomic_load(&job.error_number);
        perror("Export failed; the .partial file is incomplete");
    } else if (completed != job.total) {
        fputs("Export stopped before completion; the .partial file is incomplete.\n", stderr);
    } else if (fsync(job.fd) != 0) {
        perror("Could not flush output");
    } else if (close(job.fd) != 0) {
        perror("Could not close output");
        job.fd = -1;
    } else {
        job.fd = -1;
        if (link(partial, output) != 0) {
            perror("Could not publish output without overwriting");
        } else {
            unlink(partial);
            const double total_elapsed = monotonic_seconds() - started;
            const double overall_rate = total_elapsed > 0 ? (double)job.total / total_elapsed : 0.0;
            printf("Complete: %llu rows, %llu bytes, %.0f rows/s\nSaved locally: %s\n",
                   (unsigned long long)job.total,
                   (unsigned long long)(job.total * ROW_BYTES), overall_rate, output);
            result = 0;
        }
    }
    if (job.fd >= 0) close(job.fd);
    wipe(&job.lower, sizeof job.lower);
    free(partial);
    return result;
}
