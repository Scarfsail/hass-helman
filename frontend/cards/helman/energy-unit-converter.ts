/**
 * Utility functions for energy unit conversion
 */

/**
 * Converts energy value to kWh based on the unit of measurement from Home Assistant state
 * @param value - The numeric value from the sensor
 * @param unitOfMeasurement - The unit_of_measurement attribute from the sensor state
 * @returns The value converted to kWh
 */
export function convertToKWh(value: number, unitOfMeasurement: string | undefined): number {
    if (!unitOfMeasurement) {
        // If no unit specified, assume Wh for backward compatibility
        console.warn('No unit_of_measurement found for energy sensor, assuming Wh');
        return value / 1000;
    }

    const unit = unitOfMeasurement.toLowerCase();
    
    switch (unit) {
        case 'kwh':
        case 'kw⋅h':
            // Already in kWh
            return value;
        
        case 'wh':
        case 'w⋅h':
            // Convert from Wh to kWh
            return value / 1000;
        
        case 'mwh':
        case 'mw⋅h':
            // Convert from MWh to kWh
            return value * 1000;
        
        case 'gwh':
        case 'gw⋅h':
            // Convert from GWh to kWh (rarely used but for completeness)
            return value * 1000000;
        
        default:
            // Unknown unit, log warning and assume Wh for backward compatibility
            console.warn(`Unknown energy unit '${unitOfMeasurement}', assuming Wh for conversion`);
            return value / 1000;
    }
}

/**
 * Gets the appropriate display unit based on the magnitude of the kWh value
 * @param kwhValue - Value in kWh
 * @returns Object with converted value and unit string
 */
export function getDisplayEnergyUnit(kwhValue: number): { value: number; unit: string } {
    if (kwhValue >= 1000000) {
        // Use GWh for very large values
        return { value: kwhValue / 1000000, unit: 'GWh' };
    } else if (kwhValue >= 1000) {
        // Use MWh for large values
        return { value: kwhValue / 1000, unit: 'MWh' };
    } else if (kwhValue >= 0.1) {
        // Use kWh for normal values
        return { value: kwhValue, unit: 'kWh' };
    } else {
        // Use Wh for small values
        return { value: kwhValue * 1000, unit: 'Wh' };
    }
}