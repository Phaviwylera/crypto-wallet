/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Small Keccak-256 implementation for Seedlab's native scalar exporter. */
#ifndef SEEDLAB_KECCAK256_H
#define SEEDLAB_KECCAK256_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static uint64_t seedlab_rotl64(uint64_t value, unsigned shift)
{
    return shift ? (value << shift) | (value >> (64 - shift)) : value;
}

static uint64_t seedlab_load64_le(const uint8_t bytes[8])
{
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; i++) value |= (uint64_t)bytes[i] << (8 * i);
    return value;
}

static void seedlab_store64_le(uint8_t bytes[8], uint64_t value)
{
    for (unsigned i = 0; i < 8; i++) bytes[i] = (uint8_t)(value >> (8 * i));
}

static void seedlab_keccak_f1600(uint64_t state[25])
{
    static const uint64_t round_constants[24] = {
        UINT64_C(0x0000000000000001), UINT64_C(0x0000000000008082),
        UINT64_C(0x800000000000808a), UINT64_C(0x8000000080008000),
        UINT64_C(0x000000000000808b), UINT64_C(0x0000000080000001),
        UINT64_C(0x8000000080008081), UINT64_C(0x8000000000008009),
        UINT64_C(0x000000000000008a), UINT64_C(0x0000000000000088),
        UINT64_C(0x0000000080008009), UINT64_C(0x000000008000000a),
        UINT64_C(0x000000008000808b), UINT64_C(0x800000000000008b),
        UINT64_C(0x8000000000008089), UINT64_C(0x8000000000008003),
        UINT64_C(0x8000000000008002), UINT64_C(0x8000000000000080),
        UINT64_C(0x000000000000800a), UINT64_C(0x800000008000000a),
        UINT64_C(0x8000000080008081), UINT64_C(0x8000000000008080),
        UINT64_C(0x0000000080000001), UINT64_C(0x8000000080008008),
    };
    static const unsigned rotations[24] = {
        1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
        27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
    };
    static const unsigned permutation[24] = {
        10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
        15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
    };

    for (unsigned round = 0; round < 24; round++) {
        uint64_t columns[5];
        for (unsigned x = 0; x < 5; x++) {
            columns[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        }
        for (unsigned x = 0; x < 5; x++) {
            const uint64_t delta = columns[(x + 4) % 5] ^ seedlab_rotl64(columns[(x + 1) % 5], 1);
            for (unsigned y = 0; y < 25; y += 5) state[y + x] ^= delta;
        }

        uint64_t current = state[1];
        for (unsigned i = 0; i < 24; i++) {
            const unsigned destination = permutation[i];
            const uint64_t saved = state[destination];
            state[destination] = seedlab_rotl64(current, rotations[i]);
            current = saved;
        }

        for (unsigned y = 0; y < 25; y += 5) {
            for (unsigned x = 0; x < 5; x++) columns[x] = state[y + x];
            for (unsigned x = 0; x < 5; x++) {
                state[y + x] = columns[x] ^ ((~columns[(x + 1) % 5]) & columns[(x + 2) % 5]);
            }
        }
        state[0] ^= round_constants[round];
    }
}

/* Keccak-256, with the original 0x01 domain suffix (not SHA3-256's 0x06). */
static void seedlab_keccak256(const uint8_t *input, size_t length, uint8_t output[32])
{
    uint64_t state[25] = {0};
    const size_t rate = 136;

    while (length >= rate) {
        for (unsigned lane = 0; lane < rate / 8; lane++) state[lane] ^= seedlab_load64_le(input + lane * 8);
        seedlab_keccak_f1600(state);
        input += rate;
        length -= rate;
    }

    uint8_t final_block[136] = {0};
    memcpy(final_block, input, length);
    final_block[length] = 0x01;
    final_block[rate - 1] |= 0x80;
    for (unsigned lane = 0; lane < rate / 8; lane++) state[lane] ^= seedlab_load64_le(final_block + lane * 8);
    seedlab_keccak_f1600(state);
    for (unsigned lane = 0; lane < 4; lane++) seedlab_store64_le(output + lane * 8, state[lane]);
}

#endif
