import React from 'react';

const LoadingSpinner: React.FC = () => (
  <div className="flex items-center justify-center h-full w-full">
    <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-blue-500 border-b-4 border-gray-200" />
  </div>
);

export default LoadingSpinner;
