'use strict';
/**
 * Polynomial calibration for temperature sensors
 * 
 * Implements peer calibration (cross-calibration) where sensors calibrate against
 * each other or against an independent reference thermometer reading.
 * 
 * Uses least-squares polynomial fitting to compute correction coefficients.
 */

/**
 * Compute polynomial regression coefficients using least squares
 * @param {Array<number>} x - Independent variable (raw sensor temps)
 * @param {Array<number>} y - Dependent variable (reference temps)
 * @param {number} degree - Polynomial degree (1=linear, 2=quadratic, 3=cubic)
 * @returns {Array<number>} Coefficients [c0, c1, c2, ...] where y = c0 + c1*x + c2*x^2 + ...
 */
function polynomialFit(x, y, degree) {
    if (x.length !== y.length) {
        throw new Error('x and y must have same length');
    }
    if (x.length < degree + 1) {
        throw new Error(`Need at least ${degree + 1} points for degree ${degree} polynomial`);
    }
    
    const n = x.length;
    const order = degree + 1;
    
    // Build design matrix A and response vector b
    // For degree 2: [1, x, x^2] for each point
    const A = [];
    const b = y.slice(); // Copy y values
    
    for (let i = 0; i < n; i++) {
        const row = [];
        for (let j = 0; j <= degree; j++) {
            row.push(Math.pow(x[i], j));
        }
        A.push(row);
    }
    
    // Solve normal equations: (A^T * A) * coeffs = A^T * b
    const AtA = matrixMultiply(transpose(A), A);
    const Atb = matrixVectorMultiply(transpose(A), b);
    
    // Solve using Gaussian elimination
    const coeffs = solveLinearSystem(AtA, Atb);
    
    return coeffs;
}

/**
 * Transpose a matrix
 */
function transpose(matrix) {
    const rows = matrix.length;
    const cols = matrix[0].length;
    const result = [];
    
    for (let j = 0; j < cols; j++) {
        const row = [];
        for (let i = 0; i < rows; i++) {
            row.push(matrix[i][j]);
        }
        result.push(row);
    }
    
    return result;
}

/**
 * Matrix multiplication: C = A * B
 */
function matrixMultiply(A, B) {
    const rowsA = A.length;
    const colsA = A[0].length;
    const colsB = B[0].length;
    
    const result = [];
    for (let i = 0; i < rowsA; i++) {
        const row = [];
        for (let j = 0; j < colsB; j++) {
            let sum = 0;
            for (let k = 0; k < colsA; k++) {
                sum += A[i][k] * B[k][j];
            }
            row.push(sum);
        }
        result.push(row);
    }
    
    return result;
}

/**
 * Matrix-vector multiplication: result = A * v
 */
function matrixVectorMultiply(A, v) {
    const result = [];
    for (let i = 0; i < A.length; i++) {
        let sum = 0;
        for (let j = 0; j < A[i].length; j++) {
            sum += A[i][j] * v[j];
        }
        result.push(sum);
    }
    return result;
}

/**
 * Solve linear system Ax = b using Gaussian elimination with partial pivoting
 */
function solveLinearSystem(A, b) {
    const n = A.length;
    // Make copies to avoid modifying originals
    const matrix = A.map(row => row.slice());
    const rhs = b.slice();
    
    // Forward elimination with partial pivoting
    for (let col = 0; col < n; col++) {
        // Find pivot
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(matrix[row][col]) > Math.abs(matrix[maxRow][col])) {
                maxRow = row;
            }
        }
        
        // Swap rows
        [matrix[col], matrix[maxRow]] = [matrix[maxRow], matrix[col]];
        [rhs[col], rhs[maxRow]] = [rhs[maxRow], rhs[col]];
        
        // Check for singular matrix
        if (Math.abs(matrix[col][col]) < 1e-10) {
            throw new Error('Singular matrix - cannot solve');
        }
        
        // Eliminate column
        for (let row = col + 1; row < n; row++) {
            const factor = matrix[row][col] / matrix[col][col];
            for (let j = col; j < n; j++) {
                matrix[row][j] -= factor * matrix[col][j];
            }
            rhs[row] -= factor * rhs[col];
        }
    }
    
    // Back substitution
    const solution = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sum = rhs[i];
        for (let j = i + 1; j < n; j++) {
            sum -= matrix[i][j] * solution[j];
        }
        solution[i] = sum / matrix[i][i];
    }
    
    return solution;
}

/**
 * Calculate RMSE (Root Mean Square Error)
 * @param {Array<number>} actual - Actual values
 * @param {Array<number>} predicted - Predicted values
 * @returns {number} RMSE
 */
function calculateRMSE(actual, predicted) {
    if (actual.length !== predicted.length) {
        throw new Error('Arrays must have same length');
    }
    
    const n = actual.length;
    let sumSquaredError = 0;
    
    for (let i = 0; i < n; i++) {
        const error = actual[i] - predicted[i];
        sumSquaredError += error * error;
    }
    
    return Math.sqrt(sumSquaredError / n);
}

/**
 * Apply polynomial correction
 * @param {Array<number>} coeffs - Polynomial coefficients [c0, c1, c2, ...]
 * @param {number} rawValue - Raw sensor value
 * @returns {number} Corrected value
 */
function applyPolynomial(coeffs, rawValue) {
    let result = 0;
    for (let i = 0; i < coeffs.length; i++) {
        result += coeffs[i] * Math.pow(rawValue, i);
    }
    return result;
}

/**
 * Compute calibration coefficients for all sensors
 * 
 * @param {Object} calibData - Calibration data from getCalibrationData()
 *   Array of { session_id, session_name, reference_temp, unit_id, mean_temp, count }
 * @param {number} [degree=2] - Polynomial degree (1, 2, or 3)
 * @returns {Object} { a: {coeffs, rmse, numPoints}, b: {...}, c: {...} }
 */
function computeCalibrationCoefficients(calibData, degree = 2) {
    // Group data by unit
    const byUnit = { a: [], b: [], c: [] };
    
    for (const point of calibData) {
        byUnit[point.unit_id].push(point);
    }
    
    const results = {};
    
    // For each unit, compute its calibration curve
    for (const [unitId, points] of Object.entries(byUnit)) {
        if (points.length < degree + 1) {
            console.warn(`[calibration] Unit ${unitId}: not enough points (${points.length}) for degree ${degree} polynomial`);
            continue;
        }
        
        // Build arrays of (sensor_reading, reference_temp)
        const sensorReadings = [];
        const referenceTemps = [];
        
        // First pass: collect all reference temps (if provided) or compute global mean
        const allMeans = points.map(p => p.mean_temp);
        const globalMean = allMeans.reduce((a, b) => a + b, 0) / allMeans.length;
        
        for (const point of points) {
            const sensorTemp = point.mean_temp;
            // Use provided reference temp, or fallback to global mean of all sensors at that session
            const referenceTemp = point.reference_temp ?? globalMean;
            
            sensorReadings.push(sensorTemp);
            referenceTemps.push(referenceTemp);
        }
        
        try {
            // Fit polynomial: referenceTemp = f(sensorReading)
            const coeffs = polynomialFit(sensorReadings, referenceTemps, degree);
            
            // Calculate RMSE
            const predicted = sensorReadings.map(x => applyPolynomial(coeffs, x));
            const rmse = calculateRMSE(referenceTemps, predicted);
            
            results[unitId] = {
                coeffs,
                rmse,
                numPoints: points.length,
                degree,
            };
            
            console.log(`[calibration] Unit ${unitId}: ${points.length} points, RMSE = ${rmse.toFixed(3)}°C`);
            console.log(`  Coefficients: [${coeffs.map(c => c.toFixed(4)).join(', ')}]`);
            
        } catch (err) {
            console.error(`[calibration] Unit ${unitId}: failed to compute coefficients:`, err.message);
        }
    }
    
    return results;
}

/**
 * Format calibration results for display
 * @param {Object} results - Results from computeCalibrationCoefficients
 * @returns {string} Human-readable summary
 */
function formatCalibrationResults(results) {
    const lines = ['Calibration Results:', ''];
    
    for (const [unitId, result] of Object.entries(results)) {
        lines.push(`Unit ${unitId.toUpperCase()}:`);
        lines.push(`  Points: ${result.numPoints}`);
        lines.push(`  Degree: ${result.degree}`);
        lines.push(`  RMSE: ${result.rmse.toFixed(3)}°C`);
        
        const coeffLabels = ['c0 (const)', 'c1 (linear)', 'c2 (quad)', 'c3 (cubic)'];
        for (let i = 0; i < result.coeffs.length; i++) {
            lines.push(`  ${coeffLabels[i]}: ${result.coeffs[i].toFixed(6)}`);
        }
        lines.push('');
    }
    
    return lines.join('\n');
}

module.exports = {
    polynomialFit,
    calculateRMSE,
    applyPolynomial,
    computeCalibrationCoefficients,
    formatCalibrationResults,
};
