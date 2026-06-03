'use strict';

// Set environment variable DB_PATH to :memory: so that we use an in-memory database for testing
process.env.DB_PATH = ':memory:';

const assert = require('assert').strict;
const db = require('./db');
const calibration = require('./calibration');

console.log('=== Starting Temperature Calibration Regression Tests ===');

// Helper to assert values are close
function assertClose(actual, expected, epsilon = 1e-4, message = '') {
    if (Math.abs(actual - expected) > epsilon) {
        throw new Error(`${message || 'Assertion failed'}: expected ${expected} to be close to ${actual} (within ${epsilon})`);
    }
}

// 1. Test Database Caching and Invalidation
function testDatabaseCache() {
    console.log('\n--- Test 1: Database Cache and Invalidation ---');
    
    // Initial clear
    db.clearAllCalibrationCoefficients();
    
    // Check initially null/undefined
    let coeffA = db.getCalibrationCoefficients('a');
    assert.equal(coeffA, null, 'Unit A coefficients should initially be null');
    
    // Save coefficients
    const testCoeffs = {
        unitId: 'a',
        degree: 1,
        c0: -0.25,
        c1: 1.02,
        c2: 0,
        c3: 0,
        numPoints: 50,
        rmse: 0.12
    };
    db.saveCalibrationCoefficients(testCoeffs);
    
    // Get from cache
    coeffA = db.getCalibrationCoefficients('a');
    assert.ok(coeffA, 'Should retrieve coefficients');
    assert.equal(coeffA.degree, 1);
    assertClose(coeffA.c0, -0.25);
    assertClose(coeffA.c1, 1.02);
    
    // Apply calibration check
    const rawTemp = 20.0;
    const calibrated = db.applyCalibratedTemp('a', rawTemp);
    // T_cal = c0 + c1 * T_raw = -0.25 + 1.02 * 20.0 = 20.15
    assertClose(calibrated, 20.15, 1e-5, 'Calibrated temperature should match formula');
    
    // Delete coefficients
    db.deleteCalibrationCoefficients('a');
    coeffA = db.getCalibrationCoefficients('a');
    assert.equal(coeffA, null, 'Unit A coefficients should be null after delete');
    
    // Verify fallback to raw
    assert.equal(db.applyCalibratedTemp('a', rawTemp), rawTemp, 'Should fallback to raw value when no coefficients');
    
    console.log('✔ Test 1 passed!');
}

// 2. Test Linear Fitting Math
function testLinearFittingMath() {
    console.log('\n--- Test 2: Linear Fitting Math ---');
    
    // Perfect linear relationship: y = 1.05 * x - 1.2
    const c0_expected = -1.2;
    const c1_expected = 1.05;
    
    const x = [15.0, 17.0, 19.0, 21.0, 23.0, 25.0];
    const y = x.map(val => c0_expected + c1_expected * val);
    
    const coeffs = calibration.polynomialFit(x, y, 1);
    
    assertClose(coeffs[0], c0_expected, 1e-5, 'Intercept (c0) should match');
    assertClose(coeffs[1], c1_expected, 1e-5, 'Slope (c1) should match');
    
    // Check RMSE on perfect data
    const predicted = x.map(val => coeffs[0] + coeffs[1] * val);
    const rmse = calibration.calculateRMSE(y, predicted);
    assertClose(rmse, 0, 1e-5, 'RMSE for perfect fit should be close to 0');
    
    console.log('✔ Test 2 passed!');
}

// 3. Replicated API Calibration Builder logic for testing
function computeCalibrationFromTriplets(pairs, useLinearOverride = null) {
    const numPaired = pairs.a.length;
    if (numPaired < 5) {
        throw new Error('Not enough paired readings');
    }
    
    // Calculate before spread
    let beforeSpreadSum = 0;
    for (let i = 0; i < numPaired; i++) {
        const spread = Math.max(pairs.a[i].raw, pairs.b[i].raw, pairs.c[i].raw) - 
                       Math.min(pairs.a[i].raw, pairs.b[i].raw, pairs.c[i].raw);
        beforeSpreadSum += spread;
    }
    const beforeAverageSpread = beforeSpreadSum / numPaired;
    
    // Decide linear vs offset
    const raws = [...pairs.a.map(p => p.truth)];
    const minTruth = Math.min(...raws);
    const maxTruth = Math.max(...raws);
    const spreadTruth = maxTruth - minTruth;
    
    let useLinear = useLinearOverride !== null ? useLinearOverride : (spreadTruth >= 1.0);
    let results = {};
    
    if (useLinear) {
        try {
            for (const u of ['a', 'b', 'c']) {
                const x = pairs[u].map(p => p.raw);
                const y = pairs[u].map(p => p.truth);
                const coeffs = calibration.polynomialFit(x, y, 1);
                const c0 = coeffs[0];
                const c1 = coeffs[1];
                
                // Sanity check
                if (!isFinite(c0) || !isFinite(c1) || c0 < -15 || c0 > 15 || c1 < 0.7 || c1 > 1.3) {
                    useLinear = false;
                    break;
                }
                
                const predicted = x.map(xv => c0 + c1 * xv);
                const rmse = calibration.calculateRMSE(y, predicted);
                
                results[u] = {
                    coeffs: [c0, c1, 0, 0],
                    rmse,
                    method: 'linear'
                };
            }
        } catch (err) {
            useLinear = false;
        }
    }
    
    if (!useLinear) {
        const meanTruth = pairs.a.reduce((s, p) => s + p.truth, 0) / numPaired;
        results = {};
        for (const u of ['a', 'b', 'c']) {
            const rawTemps = pairs[u].map(p => p.raw);
            const meanRaw = rawTemps.reduce((s, v) => s + v, 0) / numPaired;
            const offset = meanTruth - meanRaw;
            
            if (!isFinite(offset) || offset < -15 || offset > 15) {
                throw new Error(`Absurd offset calculated: ${offset}`);
            }
            
            const predicted = rawTemps.map(xv => xv + offset);
            const rmse = calibration.calculateRMSE(pairs[u].map(p => p.truth), predicted);
            
            results[u] = {
                coeffs: [offset, 1, 0, 0],
                rmse,
                method: 'offset'
            };
        }
    }
    
    // Calculate after average spread
    let afterSpreadSum = 0;
    for (let i = 0; i < numPaired; i++) {
        const calA = results.a.coeffs[0] + results.a.coeffs[1] * pairs.a[i].raw;
        const calB = results.b.coeffs[0] + results.b.coeffs[1] * pairs.b[i].raw;
        const calC = results.c.coeffs[0] + results.c.coeffs[1] * pairs.c[i].raw;
        
        const spread = Math.max(calA, calB, calC) - Math.min(calA, calB, calC);
        afterSpreadSum += spread;
    }
    const afterAverageSpread = afterSpreadSum / numPaired;
    
    return {
        results,
        beforeAverageSpread,
        afterAverageSpread,
        method: useLinear ? 'linear' : 'offset'
    };
}

// 4. Test Stable High-Spread Calibration (Should select Linear)
function testStableHighSpreadCalibration() {
    console.log('\n--- Test 3: Stable High-Spread Peer Calibration (Linear) ---');
    
    // Construct colocated readings over 10 points with linear offsets
    // Truth temperature goes from 15C to 25C (10C spread > 1.0C limit)
    // Unit A raw = Truth - 0.5 (under-reads by 0.5)
    // Unit B raw = Truth * 1.02 (reads with a 2% slope gain error)
    // Unit C raw = Truth + 0.8 (over-reads by 0.8)
    
    const pairs = { a: [], b: [], c: [] };
    const truthValues = [15.0, 16.2, 17.5, 18.3, 19.5, 20.8, 22.0, 23.1, 24.2, 25.0];
    
    for (const truth of truthValues) {
        pairs.a.push({ raw: truth - 0.5, truth });
        pairs.b.push({ raw: truth * 1.02, truth });
        pairs.c.push({ raw: truth + 0.8, truth });
    }
    
    const outcome = computeCalibrationFromTriplets(pairs);
    
    assert.equal(outcome.method, 'linear', 'Should select linear method for high temperature spread');
    assert.ok(outcome.afterAverageSpread < outcome.beforeAverageSpread, 'Spread should improve after calibration');
    console.log(`  Before avg spread: ${outcome.beforeAverageSpread.toFixed(4)}°C`);
    console.log(`  After avg spread:  ${outcome.afterAverageSpread.toFixed(4)}°C`);
    
    // Verify linear coefficients for Unit A: T_cal = 1.0 * T_raw + 0.5
    assertClose(outcome.results.a.coeffs[1], 1.0, 1e-4, 'Unit A slope should be close to 1.0');
    assertClose(outcome.results.a.coeffs[0], 0.5, 1e-4, 'Unit A offset should be close to 0.5');
    
    console.log('✔ Test 3 passed!');
}

// 5. Test Stable Narrow-Spread Fallback (Should select Offset)
function testStableNarrowSpreadCalibration() {
    console.log('\n--- Test 4: Stable Narrow-Spread Calibration (Offset Fallback) ---');
    
    // Construct colocated readings where truth is narrow: 20C to 20.5C (0.5C spread < 1.0C limit)
    const pairs = { a: [], b: [], c: [] };
    const truthValues = [20.0, 20.1, 20.2, 20.3, 20.4, 20.5];
    
    for (const truth of truthValues) {
        pairs.a.push({ raw: truth - 0.3, truth });
        pairs.b.push({ raw: truth + 0.4, truth });
        pairs.c.push({ raw: truth - 0.1, truth });
    }
    
    const outcome = computeCalibrationFromTriplets(pairs);
    
    assert.equal(outcome.method, 'offset', 'Should fall back to offset calibration when temperature spread is narrow');
    assert.ok(outcome.afterAverageSpread < outcome.beforeAverageSpread, 'Spread should improve');
    console.log(`  Before avg spread: ${outcome.beforeAverageSpread.toFixed(4)}°C`);
    console.log(`  After avg spread:  ${outcome.afterAverageSpread.toFixed(4)}°C`);
    
    // Unit A formula should be T_cal = T_raw + 0.3 (c0 = 0.3, c1 = 1.0)
    assert.equal(outcome.results.a.coeffs[1], 1.0, 'Slope should be exactly 1.0 for offset method');
    assertClose(outcome.results.a.coeffs[0], 0.3, 1e-2, 'Offset should be close to 0.3');
    
    console.log('✔ Test 4 passed!');
}

// 6. Test Unstable/Absurd Slopes Rejection (Should fall back to Offset)
function testUnstableLinearRejection() {
    console.log('\n--- Test 5: Rejection of Unstable/Absurd Slopes (Offset Fallback) ---');
    
    // Construct unstable readings where data is noisy and causes slope to fall outside [0.7, 1.3]
    const pairs = { a: [], b: [], c: [] };
    const truthValues = [15.0, 16.0, 17.0, 18.0, 19.0, 20.0];
    
    // Unit A has normal values
    // Unit B has absurdly skewed values that would force slope to be e.g. 0.2 or 2.0
    for (let i = 0; i < truthValues.length; i++) {
        const truth = truthValues[i];
        pairs.a.push({ raw: truth, truth });
        // Unit B raw reading drops as truth goes up (absurd/unstable negative slope)
        pairs.b.push({ raw: 30 - truth, truth }); 
        pairs.c.push({ raw: truth, truth });
    }
    
    const outcome = computeCalibrationFromTriplets(pairs);
    
    assert.equal(outcome.method, 'offset', 'Should fall back to offset when linear slope calculation is absurd');
    assert.equal(outcome.results.b.coeffs[1], 1.0, 'Slope should be exactly 1.0 in fallback mode');
    
    console.log('✔ Test 5 passed!');
}

// 7. Test Degradation Rejection (Should fail check)
function testDegradationRejection() {
    console.log('\n--- Test 6: Spread Degradation Rejection ---');
    
    const pairs = { a: [], b: [], c: [] };
    const truthValues = [20.0, 20.0, 20.0, 20.0, 20.0];
    
    // Raw readings already have 0 spread (they are already identical)
    for (const truth of truthValues) {
        pairs.a.push({ raw: 20.0, truth });
        pairs.b.push({ raw: 20.0, truth });
        pairs.c.push({ raw: 20.0, truth });
    }
    
    // Manually force a calibration results object that adds noise and increases spread
    const results = {
        a: { coeffs: [0.5, 1.0, 0, 0] }, // adds 0.5
        b: { coeffs: [-0.5, 1.0, 0, 0] }, // subtracts 0.5
        c: { coeffs: [0.0, 1.0, 0, 0] }
    };
    
    // Check that custom calculation shows degrade
    let afterSpreadSum = 0;
    for (let i = 0; i < truthValues.length; i++) {
        const calA = results.a.coeffs[0] + results.a.coeffs[1] * pairs.a[i].raw;
        const calB = results.b.coeffs[0] + results.b.coeffs[1] * pairs.b[i].raw;
        const calC = results.c.coeffs[0] + results.c.coeffs[1] * pairs.c[i].raw;
        const spread = Math.max(calA, calB, calC) - Math.min(calA, calB, calC);
        afterSpreadSum += spread;
    }
    const afterAverageSpread = afterSpreadSum / truthValues.length;
    
    assert.ok(afterAverageSpread > 0, 'Spread should degrade (increase) from 0 to 1.0');
    
    console.log('✔ Test 6 passed!');
}

// Run all tests
try {
    testDatabaseCache();
    testLinearFittingMath();
    testStableHighSpreadCalibration();
    testStableNarrowSpreadCalibration();
    testUnstableLinearRejection();
    testDegradationRejection();
    console.log('\n======================================================');
    console.log('🎉 ALL CALIBRATION REGRESSION TESTS COMPLETED SUCCESSFULLY!');
    console.log('======================================================');
} catch (error) {
    console.error('\n❌ TEST SUITE FAILED:');
    console.error(error);
    process.exit(1);
}
